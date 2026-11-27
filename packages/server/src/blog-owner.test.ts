// The blog owner's helper routes (./blog-owner.ts): the live slug check and a
// post's public address; and that excluding the blog folder in the shared
// config takes its posts down. Through the real HTTP handler, against
// Postgres. Invented content only.

import { expect, it } from 'vitest';
import { BLOG_ROLES, brainWithBlog } from './blog.testing.js';
import { type TestServer, createBrain, describePg, testServer } from './test-env.testing.js';

const page = async (server: TestServer, slug: string, key: string) =>
  (await server.app.blogs?.open(slug))?.snapshot.byKey(key) ?? null;

describePg('blog owner routes', () => {
  it('checks a slug: invalid, reserved, taken by another blog, or free', async () => {
    const server = await testServer();
    await brainWithBlog(server, 'kitchen', 'baking-notes');
    await createBrain(server, 'garden');
    const check = async (brain: string, slug: string) =>
      (await server.request('GET', `/api/brains/${brain}/blog/slug?slug=${slug}`)).body;
    expect(await check('garden', 'baking-notes')).toMatchObject({
      available: false,
      taken: true,
      problem: 'another blog on this server has that name',
    });
    // A blog's own slug is not "taken" for it.
    expect(await check('kitchen', 'baking-notes')).toMatchObject({ available: true, taken: false });
    expect(await check('garden', 'api')).toMatchObject({
      available: false,
      problem: 'that slug is reserved',
    });
    expect((await check('garden', 'No_Good')).available).toBe(false);
    expect(await check('garden', 'my-garden')).toMatchObject({ available: true, problem: null });
    expect((await server.request('GET', '/api/brains/nobody/blog/slug?slug=x1')).status).toBe(404);
  });

  it('gives a post its public address only when the blog is on', async () => {
    const server = await testServer();
    await brainWithBlog(server, 'kitchen', 'baking-notes');
    const address = async (path: string) =>
      (await server.request('GET', `/api/brains/kitchen/blog/address?path=${path}`)).body.url;
    expect(await address('blog/2026/2026-03-14-pi-day.md')).toBe(
      '/blog/baking-notes/2026/03/14/pi-day',
    );
    expect(await address('blog/about.md')).toBe('/blog/baking-notes/p/about');
    expect(await address('memos/recipe-box.md')).toBeNull();
    expect(await address('blog/hidden/2026/2026-06-01-excluded.md')).toBeNull();
    expect(
      (await server.request('GET', '/api/brains/kitchen/blog/address?path=../x.md')).status,
    ).toBe(400);
    await server.request('PUT', '/api/brains/kitchen/blog', {
      enabled: false,
      slug: 'baking-notes',
      title: 'Off',
    });
    expect(await address('blog/2026/2026-03-14-pi-day.md')).toBeNull();
  });

  it('excluding the blog folder in the shared config takes its posts down at once', async () => {
    const server = await testServer();
    await brainWithBlog(server, 'kitchen', 'baking-notes');
    expect(await page(server, 'baking-notes', '2026/03/14/pi-day')).not.toBeNull();
    const current = await server.request('GET', '/api/brains/kitchen/config');
    const r = await server.request('PUT', '/api/brains/kitchen/config', {
      baseRevision: current.body.revision,
      config: { ...current.body.config, roles: { ...BLOG_ROLES, excluded: ['private/', 'blog/'] } },
    });
    expect(r.status).toBe(200);
    expect(await page(server, 'baking-notes', '2026/03/14/pi-day')).toBeNull();
  });
});
