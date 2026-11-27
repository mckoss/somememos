// The public blog pages through SvelteKit's real endpoint module
// (routes/blog/[...path]/+server.ts) and the robots.txt hook, against a
// real Postgres and brain repositories (packages/server's test helpers).
// Skipped, not failed, without SOMEMEMOS_TEST_DATABASE_URL. All content is
// invented.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublicLimiter, type PublicBlogs } from '@somememos/server';
import { createPgStores } from '@somememos/pg-store';
import * as endpoint from '../../../routes/blog/[...path]/+server.ts';
import * as hooks from '../../../hooks.server.ts';
import { setBlogBackend } from './handler.ts';
import { NOT_FOUND_PAGE, PAGE_SIZE } from './pages.ts';
import {
  FIXTURE,
  blogClient,
  brainWithBlog,
  save,
} from '../../../../../../packages/server/src/blog.testing.ts';
import {
  TOKEN,
  describePg,
  testServer,
  type TestServer,
} from '../../../../../../packages/server/src/test-env.testing.ts';

// hooks.server.ts reads $app/env, which only the SvelteKit plugin provides.
vi.mock('$app/env', () => ({ building: false }));

type Handler = (event: unknown) => Promise<Response>;
const ORIGIN = 'https://blog.example';

async function get(path: string, headers: Record<string, string> = {}, address = '192.0.2.1') {
  const request = new Request(`${ORIGIN}${path}`, { headers });
  const r = await (endpoint.GET as Handler)({ request, getClientAddress: () => address });
  return { status: r.status, headers: r.headers, body: await r.text() };
}

/** Everything a client can observe about a response, for comparing 404s. */
const observable = (r: { status: number; headers: Headers; body: string }) => ({
  status: r.status,
  headers: [...r.headers.entries()].sort(),
  body: r.body,
});

function useServer(server: TestServer, limiter = new PublicLimiter({ perAddress: 100_000 })) {
  setBlogBackend({
    blogs: server.app.blogs as PublicBlogs,
    limiter,
    log: { error: () => undefined },
  });
}

afterEach(() => setBlogBackend(undefined));

describe('blog pages without a database', () => {
  it('answer every address with the one 404', async () => {
    setBlogBackend({ blogs: null, limiter: new PublicLimiter() });
    const first = observable(await get('/blog/garden/'));
    expect(first.status).toBe(404);
    expect(first.body).toBe(NOT_FOUND_PAGE);
    for (const path of [
      '/blog/garden/2026/03/14/pi-day',
      '/blog/garden/feed.xml',
      '/blog/',
      '/blog',
    ]) {
      expect(observable(await get(path))).toEqual(first);
    }
  });
});

describePg('the public blog pages', () => {
  const PRIVATE_ADDRESSES = [
    '/blog/garden/2026/05/02/draft-idea', // a draft
    '/blog/garden/2026/05/03/false-start', // published: false
    '/blog/garden/2026/06/01/excluded', // in an excluded folder
    '/blog/garden/p/recipe-box', // a private memo
    '/blog/garden/p/memos/recipe-box',
    '/blog/garden/p/2026-03-14', // a diary entry
    '/blog/garden/p/cookbook', // a source
    '/blog/garden/2026/03/14/nothing', // nonexistent
    '/blog/garden/2026/13/99/pi-day',
    '/blog/garden/p/%E0%A4%A', // malformed encoding
    '/blog/garden/p/..%2Fmemos%2Frecipe-box',
    '/blog/garden/2026/03/14',
    '/blog/garden/notes/memos/recipe-box.md',
    '/blog/garden-brain/', // the brain id is not the slug
    '/blog/unknown-blog/',
    '/blog/unknown-blog/2026/03/14/pi-day',
    '/blog/',
    '/blog',
    '/blog/API/',
  ];

  it('serves nothing while the blog is off, and the same 404 for anything private once on', async () => {
    const server = await testServer();
    useServer(server);
    await brainWithBlog(server, 'garden-brain', 'garden');
    const turn = (enabled: boolean) =>
      server.request('PUT', '/api/brains/garden-brain/blog', {
        enabled,
        slug: 'garden',
        title: 'Invented blog garden',
        description: 'Posts about invented things.',
        author: 'A. Writer',
      });
    await turn(false);
    const reference = observable(await get('/blog/unknown-blog/'));
    expect(reference.status).toBe(404);
    const published = [
      '/blog/garden/',
      '/blog/garden/2026/03/14/pi-day',
      '/blog/garden/p/about',
      '/blog/garden/feed.xml',
      '/blog/garden/sitemap.xml',
    ];
    for (const path of [...published, ...PRIVATE_ADDRESSES]) {
      expect(observable(await get(path)), path).toEqual(reference);
    }

    await turn(true);
    for (const path of published) expect((await get(path)).status, path).toBe(200);
    for (const path of PRIVATE_ADDRESSES) {
      expect(observable(await get(path)), path).toEqual(reference);
    }
    expect(reference.headers).toContainEqual(['x-robots-tag', 'noindex']);
    expect(reference.headers).toContainEqual(['cache-control', 'no-cache']);
  });

  it('renders the index, posts, feed and sitemap with only published posts', async () => {
    const server = await testServer();
    useServer(server);
    await brainWithBlog(server, 'garden-brain', 'garden');

    const index = await get('/blog/garden/');
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(index.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
    expect(index.headers.get('x-robots-tag')).toBeNull();
    const titles = [...index.body.matchAll(/<h2><a href="([^"]+)">([^<]+)<\/a><\/h2>/g)].map(
      (m) => [m[1], m[2]],
    );
    expect(titles).toEqual([
      ['/blog/garden/p/about', 'About this blog'],
      ['/blog/garden/2026/04/01/spring-garden', 'Spring garden'],
      ['/blog/garden/2026/03/14/pi-day', 'Baking for Pi Day'],
    ]);
    expect(index.body).toContain('<html lang="en">');
    expect(index.body).toContain('<title>Invented blog garden</title>');
    expect(index.body).toContain('<link rel="canonical" href="https://blog.example/blog/garden/">');
    expect(index.body).toContain(
      '<link rel="alternate" type="application/atom+xml" title="Invented blog garden" href="https://blog.example/blog/garden/feed.xml">',
    );
    expect(index.body).toContain(
      '<meta name="description" content="Posts about invented things.">',
    );
    expect(index.body).not.toMatch(/<script/i);

    const pi = await get('/blog/garden/2026/03/14/pi-day');
    expect(pi.status).toBe(200);
    expect(pi.body).toContain('<title>Baking for Pi Day · Invented blog garden</title>');
    expect(pi.body).toContain('<meta property="og:type" content="article">');
    expect(pi.body).toContain(
      '<meta property="og:url" content="https://blog.example/blog/garden/2026/03/14/pi-day">',
    );
    expect(pi.body).toContain('<time datetime="2026-03-14T00:00:00Z">March 14, 2026</time>');
    // Links: to a published post, a link; to a private memo or a draft, the visible text only.
    expect(pi.body).toContain('<a href="/blog/garden/2026/04/01/spring-garden">my garden</a>');
    expect(pi.body).toMatch(/and recipe-box and draft-idea\./);
    // No front matter, path, brain id or token anywhere.
    for (const page of [index, pi]) {
      expect(page.body).not.toMatch(
        /published: true|memos\/|diary\/|sources\/|blog\/2026\/|garden-brain/,
      );
      expect(page.body).not.toContain(TOKEN);
      expect(JSON.stringify([...page.headers])).not.toMatch(/garden-brain|memos|token/i);
    }
    // Older and newer: published neighbours only.
    expect(pi.body).toContain(
      '<a class="prev" href="/blog/garden/2026/04/01/spring-garden" rel="prev">',
    );
    expect(pi.body).not.toContain('rel="next"');

    const feed = await get('/blog/garden/feed.xml');
    expect(feed.status).toBe(200);
    expect(feed.headers.get('content-type')).toBe('application/atom+xml; charset=utf-8');
    expect(
      feed.body.startsWith(
        '<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom"',
      ),
    ).toBe(true);
    expect([...feed.body.matchAll(/<entry>/g)]).toHaveLength(3);
    expect(feed.body).toContain('<id>https://blog.example/blog/garden/2026/03/14/pi-day</id>');
    expect(feed.body).not.toMatch(/Draft idea|Not ready|recipe-box&lt;\/a|memos\//);
    expectWellFormed(feed.body);

    const map = await get('/blog/garden/sitemap.xml');
    expect(map.status).toBe(200);
    expect([...map.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])).toEqual([
      'https://blog.example/blog/garden/',
      'https://blog.example/blog/garden/p/about',
      'https://blog.example/blog/garden/2026/04/01/spring-garden',
      'https://blog.example/blog/garden/2026/03/14/pi-day',
    ]);
    expectWellFormed(map.body);
  });

  it('has one address per document: trailing slashes and page 1 redirect', async () => {
    const server = await testServer();
    useServer(server);
    await brainWithBlog(server, 'garden-brain', 'garden');
    const cases: [string, string][] = [
      ['/blog/garden', '/blog/garden/'],
      ['/blog/garden?page=2', '/blog/garden/?page=2'],
      ['/blog/garden/?page=1', '/blog/garden/'],
      ['/blog/garden/2026/03/14/pi-day/', '/blog/garden/2026/03/14/pi-day'],
      ['/blog/garden/feed.xml/', '/blog/garden/feed.xml'],
      ['/blog/garden/p/%61bout', '/blog/garden/p/about'],
    ];
    for (const [from, to] of cases) {
      const r = await get(from);
      expect([r.status, r.headers.get('location')], from).toEqual([308, to]);
    }
    expect((await get('/blog/garden/?page=0')).status).toBe(404);
    expect((await get('/blog/garden/?page=2')).status).toBe(404); // one page only
    expect((await get('/blog/garden/?page=x')).status).toBe(404);
  });

  it('pages the index by published posts only', async () => {
    const server = await testServer();
    useServer(server);
    const notes: Record<string, string> = {};
    for (let i = 1; i <= PAGE_SIZE + 2; i++) {
      const d = String(i).padStart(2, '0');
      notes[`blog/2026/2026-01-${d}-post-${d}.md`] = `---\npublished: true\n---\n# Post ${d}\n`;
      notes[`blog/2026/2026-02-${d}-draft-${d}.md`] = `# Draft ${d}\n`;
    }
    await brainWithBlog(server, 'many', 'many-posts', notes);
    const one = await get('/blog/many-posts/');
    const two = await get('/blog/many-posts/?page=2');
    expect([...one.body.matchAll(/<h2><a/g)]).toHaveLength(PAGE_SIZE);
    expect([...two.body.matchAll(/<h2><a/g)]).toHaveLength(2);
    expect(one.body).toContain('href="/blog/many-posts/?page=2" rel="next"');
    expect(two.body).toContain('href="/blog/many-posts/" rel="prev"');
    expect(two.body).toContain(
      '<link rel="canonical" href="https://blog.example/blog/many-posts/?page=2">',
    );
    expect(one.body + two.body).not.toMatch(/Draft/);
    expect((await get('/blog/many-posts/?page=3')).status).toBe(404);
  });

  it('revalidates with ETags, and publishing then unpublishing through sync shows and hides a post', async () => {
    const server = await testServer();
    useServer(server);
    await brainWithBlog(server, 'garden-brain', 'garden', {});
    const phone = blogClient(server, 'garden-brain', 'phone');
    await phone.engine.index();
    await phone.sync();
    const path = 'blog/2026/2026-09-09-harvest.md';
    const url = '/blog/garden/2026/09/09/harvest';
    await phone.engine.saveNote(path, '# Harvest\n\nPumpkins.\n', { baseHash: null });
    await phone.sync();
    const notFound = observable(await get('/blog/garden/2026/09/09/nothing'));
    expect(observable(await get(url))).toEqual(notFound);

    const publish = async (text: string) => {
      const v = await phone.engine.readNote(path, { record: false });
      await phone.engine.saveNote(path, text, { baseHash: v.hash });
      await phone.sync();
    };
    await publish('---\npublished: true\n---\n# Harvest\n\nPumpkins.\n');
    const page = await get(url);
    expect(page.status).toBe(200);
    const etag = page.headers.get('etag') as string;
    expect(etag).toMatch(/^"[A-Za-z0-9_-]{32}"$/);
    expect(page.headers.get('cache-control')).toBe('public, max-age=60, must-revalidate');
    const again = await get(url, { 'if-none-match': etag });
    expect(again.status).toBe(304);
    expect(again.body).toBe('');
    expect(again.headers.get('etag')).toBe(etag);
    expect((await get(url, { 'if-none-match': `W/${etag}, "other"` })).status).toBe(304);
    expect((await get('/blog/garden/')).body).toContain('Harvest');
    expect((await get('/blog/garden/feed.xml')).body).toContain('<title>Harvest</title>');
    expect((await get('/blog/garden/sitemap.xml')).body).toContain(url);

    await publish('---\npublished: true\n---\n# Harvest\n\nPumpkins and squash.\n');
    const changed = await get(url, { 'if-none-match': etag });
    expect(changed.status).toBe(200);
    expect(changed.headers.get('etag')).not.toBe(etag);

    await publish('---\npublished: false\n---\n# Harvest\n\nPumpkins and squash.\n');
    expect(observable(await get(url))).toEqual(notFound);
    expect(observable(await get(url, { 'if-none-match': etag }))).toEqual(notFound);
    expect((await get('/blog/garden/')).body).not.toContain('Harvest');
    expect((await get('/blog/garden/feed.xml')).body).not.toContain('Harvest');
    expect((await get('/blog/garden/sitemap.xml')).body).not.toContain('harvest');
  });

  it('adds no events, works while the brain is held, and keeps two blogs apart', async () => {
    const server = await testServer();
    useServer(server);
    await brainWithBlog(server, 'garden-brain', 'garden');
    await brainWithBlog(server, 'other-brain', 'other', {
      'blog/2026/2026-02-02-elsewhere.md':
        '---\npublished: true\n---\n# Elsewhere\n\n[[2026-03-14-pi-day]]\n',
    });
    const stores = await createPgStores({
      pool: server.pool,
      brainId: 'garden-brain',
      now: server.now,
    });
    const status = async () =>
      (await server.request('GET', '/api/brains/garden-brain/status')).body;
    const before = { status: await status(), events: (await stores.events.readAfter(0)).length };
    for (const path of [
      '/blog/garden/',
      '/blog/garden/2026/03/14/pi-day',
      '/blog/garden/feed.xml',
    ]) {
      expect((await get(path)).status).toBe(200);
    }
    expect({ status: await status(), events: (await stores.events.readAfter(0)).length }).toEqual(
      before,
    );

    await save(
      server,
      'garden-brain',
      'blog/2026/2026-08-08-new.md',
      '---\npublished: true\n---\n# New\n',
    );
    let inside = 0;
    await server.app.service!.withBrain('owner', 'garden-brain', {}, async () => {
      inside = (await get('/blog/garden/2026/08/08/new')).status;
    });
    expect(inside).toBe(200);

    // A post of one blog is not reachable under the other, and links don't cross.
    expect((await get('/blog/other/2026/03/14/pi-day')).status).toBe(404);
    expect((await get('/blog/garden/2026/02/02/elsewhere')).status).toBe(404);
    const elsewhere = await get('/blog/other/2026/02/02/elsewhere');
    expect(elsewhere.body).toContain('<p>2026-03-14-pi-day</p>');
  });

  it('limits anonymous requests per address', async () => {
    const server = await testServer();
    useServer(server, new PublicLimiter({ perAddress: 3 }));
    await brainWithBlog(server, 'garden-brain', 'garden', FIXTURE);
    for (let i = 0; i < 3; i++)
      expect((await get('/blog/garden/', {}, '198.51.100.7')).status).toBe(200);
    const limited = await get('/blog/garden/', {}, '198.51.100.7');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await get('/blog/garden/', {}, '198.51.100.8')).status).toBe(200);
  });

  it('serves robots.txt from the hook, allowing the blogs only', async () => {
    const server = await testServer();
    useServer(server);
    await brainWithBlog(server, 'garden-brain', 'garden', {});
    const handle = hooks.handle as unknown as (input: unknown) => Promise<Response>;
    const r = await handle({
      event: {
        url: new URL(`${ORIGIN}/robots.txt`),
        request: new Request(`${ORIGIN}/robots.txt`),
        getClientAddress: () => '192.0.2.1',
      },
      resolve: () => Promise.reject(new Error('not resolved')),
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(
      'User-agent: *\nAllow: /blog/\nDisallow: /\n\nSitemap: https://blog.example/blog/garden/sitemap.xml\n',
    );
  });
});

/** A small XML well-formedness check: balanced, properly nested tags and known entities. */
function expectWellFormed(xml: string): void {
  const body = xml.replace(/^<\?xml[^?]*\?>\s*/, '');
  const stack: string[] = [];
  for (const m of body.matchAll(
    /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|<|&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/gi,
  )) {
    expect(m[2], `stray "${m[0]}" in XML`).toBeDefined();
    if (m[4] === '/') continue;
    if (m[1] === '/') expect(stack.pop()).toBe(m[2]);
    else stack.push(m[2] as string);
  }
  expect(stack).toEqual([]);
}
