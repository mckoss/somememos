// The public renderer against hostile and ordinary markdown, without a
// database: a fake snapshot of invented posts stands in for a blog.

import { describe, expect, it } from 'vitest';
import type { BlogSnapshot, PublicPost } from '@somememos/server';
import { escapeHtml, linkLabel, renderPost } from './render.ts';
import { escapeXml } from './pages.ts';

function post(key: string, body: string, title = key): PublicPost {
  return {
    key,
    slug: key.split('/').at(-1) as string,
    date: null,
    title,
    description: null,
    body,
    hash: '0'.repeat(64),
    published: 0,
    updated: 0,
  };
}

const other = post('2026/01/02/other-post', 'Other.', 'The other post');

function render(body: string, title = 'Title'): string {
  const p = post('p/subject', body, title);
  const snapshot: BlogSnapshot = {
    posts: [p, other],
    byKey: (k) => [p, other].find((x) => x.key === k),
    // As the server resolves: only one other published post exists.
    link: (target) => (/^(2026-01-02-)?other-post$/.test(target) ? other : null),
    updated: 0,
  };
  return renderPost({ snapshot, post: p, urlOf: (x) => `/blog/b/${x.key}` });
}

const ALLOWED_TAGS = new Set(
  'a p em strong del s code pre div table thead tbody tr th td ul ol li blockquote h1 h2 h3 h4 h5 h6 hr br span'.split(
    ' ',
  ),
);
const ALLOWED_ATTRS = new Set(['href', 'id', 'class', 'rel', 'start', 'title']);

/** Every tag is one this renderer builds, with only its own attributes, and every link is safe. */
function expectSafe(html: string): void {
  for (const m of html.matchAll(/<\/?([A-Za-z][A-Za-z0-9-]*)([^>]*)>/g)) {
    const tag = (m[1] as string).toLowerCase();
    expect(ALLOWED_TAGS.has(tag), `tag <${tag}> in ${html}`).toBe(true);
    for (const a of (m[2] as string).matchAll(/\s([^\s=]+)(?:="([^"]*)")?/g)) {
      expect(ALLOWED_ATTRS.has(a[1] as string), `attribute ${a[1]} in ${m[0]}`).toBe(true);
      if (a[1] === 'href') {
        expect(a[2], m[0]).toMatch(/^(?:https?:\/\/|mailto:|#|\/blog\/b\/)/);
      }
    }
  }
  expect(html).not.toMatch(/<script|<img|<iframe|<svg|<style|<object|<embed|<form|<input/i);
  // Inside a tag (not in escaped text), nothing that could run.
  for (const m of html.matchAll(/<[^>]*>/g)) {
    expect(m[0]).not.toMatch(/javascript:|vbscript:|data:|\son[a-z]+=/i);
  }
}

describe('the public renderer', () => {
  it('neutralizes raw HTML, script and event handlers', () => {
    const hostile = [
      '<script>alert(1)</script>',
      '<img src=x onerror="alert(1)">',
      '<a href="javascript:alert(1)">click</a>',
      '<svg/onload=alert(1)>',
      '<scr<script>ipt>alert(1)</scr</script>ipt>',
      '<div style="background:url(javascript:alert(1))">x</div>',
      '<iframe src="https://example.com"></iframe>',
      '<style>body{display:none}</style>',
      '<form action="https://example.com"><input name=x></form>',
      '<!-- comment --><p onclick="x">unclosed <b>bold',
      '<details open ontoggle=alert(1)>',
      '"><img src=x onerror=alert(1)>',
    ].join('\n\n');
    const html = render(hostile);
    expectSafe(html);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('keeps only http(s), mailto and anchor links; drops the rest but keeps their text', () => {
    const html = render(
      [
        '[js](javascript:alert(1)) [js2](JaVaScRiPt:alert(1)) [vb](vbscript:msgbox)',
        '[data](data:text/html;base64,PHNjcmlwdD4=) [file](file:///etc/passwd)',
        '[rel](../memos/secret-plans.md) [abs](/api/brains/x/notes/memos/a.md) [proto](//evil.example/x)',
        '[ok](https://example.com/a?b=1&c="2") [mail](mailto:someone@example.com) [top](#top)',
        '<javascript:alert(1)> <https://example.com/auto> www.example.org',
        '[t](https://example.com "title with \\" quote")',
      ].join('\n\n'),
    );
    expectSafe(html);
    expect(html).not.toContain('secret-plans');
    expect(html).not.toContain('/api/');
    expect(html).toContain(
      '<a href="https://example.com/a?b=1&amp;c=%222%22" rel="noopener">ok</a>',
    );
    expect(html).toContain('href="mailto:someone@example.com"');
    expect(html).toContain('href="#top"');
    expect(html).toContain('<p>rel abs proto</p>'); // dropped links keep their text
    expect(html).toContain('<a href="https://example.com/auto" rel="noopener">');
    expect(html).toContain('[js](javascript:alert(1))'); // never a link at all
  });

  it('shows images and attachments as their alt text only', () => {
    const html = render(
      [
        '![a chart](https://example.com/chart.png)',
        '![x" onerror="alert(1)](data:image/png;base64,AAAA)',
        '![](attachments/photo.jpg)',
        '![[photo.png]] ![[diagram.svg|The diagram]] ![[memos/private-note]] ![[other-post]]',
      ].join('\n\n'),
    );
    expectSafe(html);
    expect(html).toContain('<span class="image-alt">a chart</span>');
    expect(html).not.toContain('photo');
    expect(html).toContain('The diagram');
    expect(html).not.toContain('memos/');
    expect(html).toContain('private-note'); // the text the author typed, as plain text
    expect(html).not.toMatch(/<a[^>]*>private-note/);
    expect(html).toContain(
      '<a href="/blog/b/2026/01/02/other-post" class="embed">The other post</a>',
    );
  });

  it('links [[links]] to published posts only, as their visible text otherwise', () => {
    const html = render(
      [
        '[[other-post]] [[2026-01-02-other-post|that post]] [[other-post#Some Part]]',
        '[[memos/secret-plans]] [[memos/secret-plans|my plans]] [[draft-thing.md]] [[nowhere/at/all]]',
        '[[#local heading]] [[x" onmouseover="alert(1)]] `[[in-code]]`',
      ].join('\n\n'),
    );
    expectSafe(html);
    expect(html).toContain('<a href="/blog/b/2026/01/02/other-post">other-post</a>');
    expect(html).toContain('<a href="/blog/b/2026/01/02/other-post">that post</a>');
    expect(html).toContain('href="/blog/b/2026/01/02/other-post#h-some-part"');
    expect(html).not.toContain('memos/');
    expect(html).toContain('secret-plans');
    expect(html).toContain('my plans');
    expect(html).toContain('draft-thing');
    expect(html).not.toContain('draft-thing.md');
    expect(html).toContain('all');
    expect(html).not.toContain('nowhere');
    expect(html).toContain('local heading');
    expect(html).toContain('<code>[[in-code]]</code>');
    expect(linkLabel({ target: 'a/b/c.md' })).toBe('c');
    expect(linkLabel({ target: 'a/b/c', alias: 'Alias' })).toBe('Alias');
  });

  it('renders ordinary markdown: headings, code and tables that scroll, tasks', () => {
    const html = render(
      [
        '# Title',
        'Intro *em* **strong** ~~gone~~ `code`.',
        '## A section',
        '```js"><script>\nconst a = "<b>";\n```',
        '| left | right |\n|:-----|------:|\n| 1 | 2 |',
        '- [ ] todo\n- [x] done',
        '> quoted',
      ].join('\n\n'),
    );
    expectSafe(html);
    expect(html).not.toMatch(/<h1/); // the first heading repeats the title, which the page shows
    expect(html).toContain('<h2 id="h-a-section">A section</h2>');
    expect(html).toContain(
      '<div class="scroll code"><pre><code class="language-js&quot;&gt;&lt;script&gt;">',
    );
    expect(html).toContain('const a = &quot;&lt;b&gt;&quot;;');
    expect(html).toContain('<div class="scroll"><table>');
    expect(html).toContain('<th class="align-left">left</th>');
    expect(html).toContain('<td class="align-right">2</td>');
    expect(html).not.toContain('style=');
    expect(html).toContain('☐ todo');
    expect(html).toContain('☑ done');
    expect(render('# Another\n\ntext')).toContain('<h1 id="h-another">Another</h1>');
  });

  it('escapes text for HTML and XML, dropping characters neither can carry', () => {
    expect(escapeHtml('<a href="x">&\'\u0000\u0007')).toBe(
      '&#60;a href=&#34;x&#34;&#62;&#38;&#39;',
    );
    expect(escapeXml('<&>"\'\u0001￿ ok')).toBe('&lt;&amp;&gt;&quot;&apos; ok');
    expect(escapeXml('\ud800 lone')).toBe(' lone');
  });
});
