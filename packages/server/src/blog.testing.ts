// Test helpers for the public blog (test-only, excluded from the build),
// shared with apps/web's page tests: an invented brain with published posts,
// drafts, private memos, a diary entry and a source. All content is invented.

import { engine as coreEngine, storage, type sync } from '@somememos/core';
import { OWNER_ID } from './auth.js';
import { TEST_ROLES, type TestServer } from './test-env.testing.js';

/** The test layout with the default blog patterns and an excluded folder inside the blog. */
export const BLOG_ROLES = {
  ...TEST_ROLES,
  excluded: [...TEST_ROLES.excluded, 'blog/hidden/'],
  blog: ['blog/{YYYY}/{YYYY}-{MM}-{DD}-*.md', 'blog/'],
};

/** Invented notes: published posts, drafts, private memos, a diary entry, a source. */
export const FIXTURE: Record<string, string> = {
  'blog/2026/2026-03-14-pi-day.md':
    '---\ntitle: Baking for Pi Day\npublished: true\n---\n# Baking for Pi Day\n\nA crust and a filling. See [[2026-04-01-spring-garden|my garden]] and [[recipe-box]] and [[draft-idea]].\n',
  'blog/2026/2026-04-01-spring-garden.md':
    '---\npublished: true\ndescription: Planting tomatoes early.\n---\n# Spring garden\n\nTomatoes, basil and [[2026-03-14-pi-day]].\n',
  'blog/2026/2026-05-02-draft-idea.md':
    '---\ntitle: Draft idea\n---\n# Not ready\n\nHalf written.\n',
  'blog/2026/2026-05-03-false-start.md': '---\npublished: false\n---\n# False start\n',
  'blog/about.md':
    '---\npublished: yes\n---\n# About this blog\n\nWritten by an invented person.\n',
  'memos/recipe-box.md': '---\npublished: true\n---\n# Recipe box\n\nPrivate recipes.\n',
  'diary/2026/03/2026-03-14.md': '---\npublished: true\n---\nA private day.\n',
  'sources/cookbook.md': '---\npublished: true\n---\n# Cookbook\n',
};

/** Saves notes through the engine route (a server-side save, as a remote client does). */
export async function save(server: TestServer, brain: string, path: string, text: string) {
  const current = await server.request('GET', `/api/brains/${brain}/notes/${path}?record=false`);
  const baseHash = current.status === 200 ? current.body.hash : null;
  const r = await server.request('PUT', `/api/brains/${brain}/notes/${path}`, { text, baseHash });
  if (r.status !== 200) throw new Error(`save ${path}: ${r.status} ${JSON.stringify(r.body)}`);
}

export async function brainWithBlog(
  server: TestServer,
  brain: string,
  slug: string,
  notes: Record<string, string> = FIXTURE,
): Promise<void> {
  const created = await server.request('POST', '/api/brains', {
    id: brain,
    config: { roles: BLOG_ROLES },
  });
  if (created.status !== 201) throw new Error(`create: ${JSON.stringify(created.body)}`);
  for (const [path, text] of Object.entries(notes)) await save(server, brain, path, text);
  if (notes === FIXTURE) {
    // No client can send a file in an excluded folder; put one in the
    // repository directly, as if it had got there some other way.
    await plant(
      server,
      brain,
      'blog/hidden/2026/2026-06-01-excluded.md',
      '---\npublished: true\n---\n# Excluded post\n',
    );
  }
  const r = await server.request('PUT', `/api/brains/${brain}/blog`, {
    enabled: true,
    slug,
    title: `Invented blog ${slug}`,
    description: 'Posts about invented things.',
    author: 'A. Writer',
  });
  if (r.status !== 200) throw new Error(`blog: ${JSON.stringify(r.body)}`);
}

/** Commits a file straight into the brain's repository, bypassing the engine (and its role checks). */
export async function plant(server: TestServer, brain: string, path: string, text: string) {
  await server.app.service!.withBrain(OWNER_ID, brain, {}, async (ctx) => {
    await ctx.content.write(path, text);
  });
}

/** An offline copy with the blog layout, syncing through the app (as `testClient`). */
export function blogClient(server: TestServer, brainId: string, id: string) {
  const stores = storage.createMemoryStores({ now: server.now });
  const content = storage.createMemoryContentStore({ now: server.now });
  const config = storage.parseBrainConfig({ clientId: id, roles: BLOG_ROLES });
  const engine = coreEngine.createEngine({ stores, content, config, now: server.now });
  const send = async (request: sync.SyncRequest): Promise<sync.SyncResponse> => {
    const r = await server.request('POST', `/api/brains/${brainId}/sync`, request);
    if (r.status !== 200) throw new Error(`sync failed: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as sync.SyncResponse;
  };
  return { engine, sync: () => coreEngine.runSync(engine, send, {}) };
}
