// The public blog's data and its privacy boundary (./blog.ts), blog settings
// (./blog-settings.ts, through the real HTTP handler) and the public rate
// limit (./blog-limit.ts). The pages themselves are tested in apps/web
// (src/lib/server/blog). All content is invented. The Postgres parts are
// skipped without SOMEMEMOS_TEST_DATABASE_URL.

import { createPgStores } from '@somememos/pg-store';
import { describe, expect, it } from 'vitest';
import { PublicLimiter } from './blog-limit.js';
import { blogSlugProblem } from './blog-settings.js';
import { postHeadline, postKey, postSlug, type PublicBlogs } from './blog.js';
import { OWNER_ID } from './auth.js';
import { BLOG_ROLES, blogClient, brainWithBlog, save } from './blog.testing.js';
import { type TestServer, createBrain, describePg, testServer } from './test-env.testing.js';

const blogsOf = (server: TestServer): PublicBlogs => server.app.blogs as PublicBlogs;

describe('post headlines', () => {
  it('never take a title or summary from an HTML comment', () => {
    expect(
      postHeadline(
        [
          '<!--',
          '# A secret working title',
          'notes to self',
          '-->',
          '',
          '# Walnut <!-- rename? --> harvest',
          '',
          '<!-- draft: check the dates -->',
          '',
          'Gathering walnuts <!-- with whom? --> in the rain.',
          '',
          'Second paragraph.',
        ].join('\n'),
        'walnut',
      ),
    ).toEqual({ title: 'Walnut harvest', description: 'Gathering walnuts in the rain.' });
    expect(postHeadline('Code `<!-- kept -->` stays.\n', 'code')).toEqual({
      title: 'Code',
      description: 'Code <!-- kept --> stays.',
    });
  });
});

describe('post addresses', () => {
  it('derives a stable key from the path and its date, never the text', () => {
    expect(postKey('blog/2026/2026-11-27-why-memos.md', '2026-11-27')).toEqual({
      key: '2026/11/27/why-memos',
      slug: 'why-memos',
    });
    expect(postKey('blog/about.md', null)).toEqual({ key: 'p/about', slug: 'about' });
    expect(postKey('blog/2026/2026-11-27.md', '2026-11-27')).toBeNull();
    expect(postSlug('Crème Brûlée & Friends!')).toBe('creme-brulee-friends');
    expect(postSlug('Ünïcode 日本語 post')).toBe('unicode-日本語-post');
    expect(postSlug('---')).toBe('');
  });

  it('validates blog slugs', () => {
    expect(blogSlugProblem('my-blog')).toBeNull();
    expect(blogSlugProblem('a1')).toBeNull();
    for (const bad of [
      '',
      'a',
      'My-Blog',
      'my_blog',
      '-x',
      'x-',
      'a--b',
      'x'.repeat(41),
      'ü-blog',
      3,
    ]) {
      expect(blogSlugProblem(bad), String(bad)).not.toBeNull();
    }
    for (const reserved of ['api', 'admin', 'blog', 'feed', 'www', 'somememos']) {
      expect(blogSlugProblem(reserved)).toBe('that slug is reserved');
    }
  });
});

describe('the public rate limit', () => {
  it('limits each address per window, and all addresses together', () => {
    let t = 0;
    const limiter = new PublicLimiter({ perAddress: 3, total: 5, windowMs: 1000, now: () => t });
    expect([1, 2, 3].map(() => limiter.take('a'))).toEqual([0, 0, 0]);
    expect(limiter.take('a')).toBe(1);
    expect(limiter.take('b')).toBe(0);
    expect(limiter.take('c')).toBe(1); // over the total
    t = 1000;
    expect(limiter.take('a')).toBe(0);
  });

  it('caps the addresses it tracks', () => {
    const limiter = new PublicLimiter({ perAddress: 2, maxAddresses: 2, now: () => 0 });
    expect(limiter.take('a') + limiter.take('b')).toBe(0);
    expect(limiter.take('c')).toBe(0);
    expect(limiter.take('d')).toBe(0);
    expect(limiter.take('e')).toBeGreaterThan(0); // c, d and e share one count
  });
});

describePg('blog settings', () => {
  it('are off by default, owner-only, validated, and unique by slug', async () => {
    const server = await testServer();
    await createBrain(server, 'alpha');
    await createBrain(server, 'beta');
    const get = await server.request('GET', '/api/brains/alpha/blog');
    expect(get.status).toBe(200);
    expect(get.body).toEqual({
      enabled: false,
      slug: null,
      title: null,
      description: null,
      author: null,
      language: 'en',
      url: null,
    });
    expect(
      (await server.request('GET', '/api/brains/alpha/blog', undefined, { token: null })).status,
    ).toBe(401);
    expect((await server.request('GET', '/api/brains/nobody/blog')).status).toBe(404);
    expect(
      (await server.request('PUT', '/api/brains/nobody/blog', { enabled: false })).status,
    ).toBe(404);

    const put = (brain: string, body: unknown) =>
      server.request('PUT', `/api/brains/${brain}/blog`, body);
    expect((await put('alpha', { enabled: true, slug: 'BAD', title: 'T' })).body.error.code).toBe(
      'invalid-slug',
    );
    expect((await put('alpha', { enabled: true, slug: 'api', title: 'T' })).body.error.code).toBe(
      'invalid-slug',
    );
    expect((await put('alpha', { enabled: true, slug: 'garden' })).status).toBe(400);
    expect((await put('alpha', { enabled: 'yes', slug: 'garden', title: 'T' })).status).toBe(400);
    expect(
      (await put('alpha', { enabled: true, slug: 'garden', title: 'T', extra: 1 })).status,
    ).toBe(400);
    expect((await put('alpha', { enabled: true, slug: 'garden', title: 'a\nb' })).status).toBe(400);
    expect(
      (await put('alpha', { enabled: true, slug: 'garden', title: 'T', language: 'x y' })).status,
    ).toBe(400);

    const ok = await put('alpha', {
      enabled: true,
      slug: 'garden',
      title: '  Garden notes ',
      language: 'en-GB',
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      enabled: true,
      slug: 'garden',
      title: 'Garden notes',
      url: '/blog/garden/',
    });
    const taken = await put('beta', { enabled: false, slug: 'garden', title: 'Mine' });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('slug-taken');
    // Turning it off keeps the slug reserved for this brain.
    expect(
      (await put('alpha', { enabled: false, slug: 'garden', title: 'Garden notes' })).body.url,
    ).toBeNull();
    expect((await put('beta', { enabled: true, slug: 'garden', title: 'Mine' })).status).toBe(409);
    // Releasing it lets another brain have it.
    expect((await put('alpha', { enabled: false })).status).toBe(200);
    expect((await put('beta', { enabled: true, slug: 'garden', title: 'Mine' })).status).toBe(200);
    // No brain id in the settings.
    expect(
      JSON.stringify((await server.request('GET', '/api/brains/beta/blog')).body),
    ).not.toContain('beta');
  });
});

describePg('the public blog boundary', () => {
  it('serves nothing until the blog is turned on, then exactly the published posts', async () => {
    const server = await testServer();
    const blogs = blogsOf(server);
    await createBrain(server, 'alpha');
    await server.request('POST', '/api/brains', { id: 'bravo', config: { roles: BLOG_ROLES } });
    expect(await blogs.open('bravo')).toBeNull(); // a brain id is not a slug
    await brainWithBlog(server, 'garden-brain', 'garden');
    const off = await server.request('PUT', '/api/brains/garden-brain/blog', {
      enabled: false,
      slug: 'garden',
      title: 'Invented blog garden',
    });
    expect(off.status).toBe(200);
    expect(await blogs.open('garden')).toBeNull();
    expect(await blogs.open('garden-brain')).toBeNull();
    expect(await blogs.open('nothing-here')).toBeNull();
    expect(await blogs.open('../etc')).toBeNull();

    await server.request('PUT', '/api/brains/garden-brain/blog', {
      enabled: true,
      slug: 'garden',
      title: 'Invented blog garden',
    });
    const blog = await blogs.open('garden');
    expect(blog).not.toBeNull();
    const { snapshot, settings } = blog!;
    expect(settings).toEqual({
      slug: 'garden',
      title: 'Invented blog garden',
      description: null,
      author: null,
      language: 'en',
    });
    // Only blog-role notes that say published: true; newest first.
    expect(snapshot.posts.map((p) => p.key)).toEqual([
      // the undated post was first saved after the dated ones' dates
      'p/about',
      '2026/04/01/spring-garden',
      '2026/03/14/pi-day',
    ]);
    const pi = snapshot.byKey('2026/03/14/pi-day')!;
    expect(pi.title).toBe('Baking for Pi Day');
    expect(pi.date).toBe('2026-03-14');
    expect(pi.published).toBe(Date.parse('2026-03-14T00:00:00Z') / 1000);
    expect(pi.body.startsWith('# Baking for Pi Day')).toBe(true); // front matter is not part of the body
    expect(pi.body).not.toContain('published');
    expect(snapshot.byKey('2026/04/01/spring-garden')!.description).toBe(
      'Planting tomatoes early.',
    );
    expect(snapshot.byKey('2026/05/02/draft-idea')).toBeUndefined();
    expect(snapshot.byKey('2026/05/03/false-start')).toBeUndefined();
    expect(snapshot.byKey('2026/06/01/excluded')).toBeUndefined();
    // Nothing in a post names a path.
    for (const p of snapshot.posts) {
      expect(Object.keys(p).sort()).toEqual(
        [
          'body',
          'date',
          'description',
          'hash',
          'key',
          'published',
          'slug',
          'title',
          'updated',
        ].sort(),
      );
      expect(JSON.stringify(p)).not.toMatch(/memos\/|diary\/|sources\/|blog\//);
    }

    // Links resolve to published posts only; a private memo, a draft or nothing gives null.
    expect(snapshot.link('2026-04-01-spring-garden', pi)?.key).toBe('2026/04/01/spring-garden');
    expect(snapshot.link('blog/2026/2026-04-01-spring-garden.md', pi)?.key).toBe(
      '2026/04/01/spring-garden',
    );
    expect(snapshot.link('about', pi)?.key).toBe('p/about');
    expect(snapshot.link('recipe-box', pi)).toBeNull();
    expect(snapshot.link('memos/recipe-box', pi)).toBeNull();
    expect(snapshot.link('2026-05-02-draft-idea', pi)).toBeNull();
    expect(snapshot.link('diary/2026/03/2026-03-14', pi)).toBeNull();
    expect(snapshot.link('nowhere', pi)).toBeNull();
  });

  it('follows publishing, unpublishing, renames and deletes through sync, at once', async () => {
    const server = await testServer();
    const blogs = blogsOf(server);
    await brainWithBlog(server, 'garden-brain', 'garden', {});
    expect((await blogs.open('garden'))!.snapshot.posts).toEqual([]);

    const phone = blogClient(server, 'garden-brain', 'phone');
    await phone.engine.index();
    await phone.sync();
    const path = 'blog/2026/2026-07-04-fireworks.md';
    await phone.engine.saveNote(path, '---\ntitle: Fireworks\n---\nLoud.\n', { baseHash: null });
    await phone.sync();
    expect((await blogs.open('garden'))!.snapshot.posts).toEqual([]); // a draft

    const view = await phone.engine.readNote(path, { record: false });
    await phone.engine.saveNote(path, '---\ntitle: Fireworks\npublished: true\n---\nLoud.\n', {
      baseHash: view.hash,
    });
    await phone.sync();
    const published = (await blogs.open('garden'))!.snapshot;
    expect(published.posts.map((p) => [p.key, p.title])).toEqual([
      ['2026/07/04/fireworks', 'Fireworks'],
    ]);

    // The text changes; the address doesn't.
    const v2 = await phone.engine.readNote(path, { record: false });
    await phone.engine.saveNote(
      path,
      '---\ntitle: Fireworks, again\npublished: true\n---\nLouder.\n',
      {
        baseHash: v2.hash,
      },
    );
    await phone.sync();
    const edited = (await blogs.open('garden'))!.snapshot;
    expect(edited.byKey('2026/07/04/fireworks')!.title).toBe('Fireworks, again');
    expect(edited.byKey('2026/07/04/fireworks')!.hash).not.toBe(
      published.byKey('2026/07/04/fireworks')!.hash,
    );

    // Renamed: the old address is gone (no redirect), the new one serves.
    await phone.engine.renameNote(path, 'blog/2026/2026-07-04-night-sky.md');
    await phone.sync();
    const renamed = (await blogs.open('garden'))!.snapshot;
    expect(renamed.posts.map((p) => p.key)).toEqual(['2026/07/04/night-sky']);

    // Unpublished: gone from every list.
    const v3 = await phone.engine.readNote('blog/2026/2026-07-04-night-sky.md', { record: false });
    await phone.engine.saveNote(
      'blog/2026/2026-07-04-night-sky.md',
      '---\ntitle: Fireworks, again\npublished: false\n---\nLouder.\n',
      { baseHash: v3.hash },
    );
    await phone.sync();
    expect((await blogs.open('garden'))!.snapshot.posts).toEqual([]);

    // Published again, then deleted.
    const v4 = await phone.engine.readNote('blog/2026/2026-07-04-night-sky.md', { record: false });
    await phone.engine.saveNote(
      'blog/2026/2026-07-04-night-sky.md',
      '---\npublished: true\n---\nBack.\n',
      {
        baseHash: v4.hash,
      },
    );
    await phone.sync();
    expect((await blogs.open('garden'))!.snapshot.posts).toHaveLength(1);
    await phone.engine.deleteNote('blog/2026/2026-07-04-night-sky.md');
    await phone.sync();
    expect((await blogs.open('garden'))!.snapshot.posts).toEqual([]);
  });

  it('logs no events, changes no score, and is not blocked by the brain lock', async () => {
    const server = await testServer();
    const blogs = blogsOf(server);
    await brainWithBlog(server, 'garden-brain', 'garden');
    const stores = await createPgStores({
      pool: server.pool,
      brainId: 'garden-brain',
      now: server.now,
    });
    const before = {
      status: (await server.request('GET', '/api/brains/garden-brain/status')).body,
      events: (await stores.events.readAfter(0)).length,
      scores: await stores.scores.getAll(),
      brain: (await server.request('GET', '/api/brains/garden-brain')).body,
    };
    for (let i = 0; i < 5; i++) {
      const blog = await blogs.open('garden');
      for (const p of blog!.snapshot.posts) blog!.snapshot.link('recipe-box', p);
    }
    expect((await stores.events.readAfter(0)).length).toBe(before.events);
    expect(await stores.scores.getAll()).toEqual(before.scores);
    expect((await server.request('GET', '/api/brains/garden-brain')).body).toEqual(before.brain);
    expect((await server.request('GET', '/api/brains/garden-brain/status')).body).toEqual(
      before.status,
    );

    // While a request holds the brain (its transaction and advisory lock), public reads still answer.
    const service = server.app.service!;
    // A new commit first, so the public read has to build a fresh snapshot.
    await save(
      server,
      'garden-brain',
      'blog/2026/2026-08-01-late.md',
      '---\npublished: true\n---\nLate.\n',
    );
    let inside = 0;
    await service.withBrain(OWNER_ID, 'garden-brain', {}, async () => {
      const blog = await Promise.race([
        blogs.open('garden'),
        new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error('blocked by the lock')), 5000),
        ),
      ]);
      inside = blog!.snapshot.posts.length;
    });
    expect(inside).toBe(4);
  });

  it('keeps two brains’ blogs apart', async () => {
    const server = await testServer();
    const blogs = blogsOf(server);
    await brainWithBlog(server, 'one', 'first-blog', {
      'blog/2026/2026-01-01-hello.md':
        '---\npublished: true\n---\n# Hello from one\n\n[[shared-name]]\n',
    });
    await brainWithBlog(server, 'two', 'second-blog', {
      'blog/2026/2026-01-02-shared-name.md': '---\npublished: true\n---\n# Two\n',
      'blog/2026/2026-01-01-hello.md': '---\npublished: false\n---\n# Draft in two\n',
    });
    const one = (await blogs.open('first-blog'))!.snapshot;
    const two = (await blogs.open('second-blog'))!.snapshot;
    expect(one.posts.map((p) => p.title)).toEqual(['Hello from one']);
    expect(two.posts.map((p) => p.title)).toEqual(['Two']);
    expect(one.link('shared-name', one.posts[0]!)).toBeNull();
    // A post of another blog cannot be passed in as the source of a link.
    expect(one.link('shared-name', two.posts[0]!)).toBeNull();
  });
});
