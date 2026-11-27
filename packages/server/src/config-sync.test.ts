// The shared config as one synced thing: the config route, the sync
// request's `configRevision`, and what a config change does on the server
// and on each copy (core's engine on in-memory stores, syncing through the
// real HTTP handler). Against Postgres and a git repository. All content
// invented.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { engine as coreEngine, storage, sync } from '@somememos/core';
import { expect, it } from 'vitest';
import {
  type TestServer,
  TEST_ROLES,
  createBrain,
  describePg,
  testServer,
} from './test-env.testing.js';

const TIMEOUT = 60_000;

interface ConfigClient {
  readonly id: string;
  engine: coreEngine.Engine;
  config: storage.BrainConfig;
  readonly stores: storage.MemoryStores;
  readonly content: storage.MemoryContentStore;
  readonly io: coreEngine.SharedConfigSync;
  /** The person changes the config on this copy (re-indexed, not yet pushed). */
  setRoles(roles: storage.BrainConfig['roles']): Promise<void>;
  sync(): Promise<coreEngine.RunSyncResult>;
  /** A sync request without `configRevision`, as a copy from before this feature sends. */
  syncLikeAnOldClient(): Promise<coreEngine.RunSyncResult>;
}

function configClient(server: TestServer, brainId: string, id: string): ConfigClient {
  const now = server.now;
  const stores = storage.createMemoryStores({ now });
  const content = storage.createMemoryContentStore({ now });
  const base = `/api/brains/${brainId}`;
  const viewOf = (body: { error: { config: sync.SharedConfig; revision: number } }) => ({
    revision: body.error.revision,
    config: body.error.config,
  });
  const client: ConfigClient = {
    id,
    stores,
    content,
    config: storage.parseBrainConfig({ clientId: id, roles: TEST_ROLES }),
    engine: undefined as unknown as coreEngine.Engine,
    io: {
      current: () => client.config,
      readState: () => sync.readSyncState(stores.meta),
      record: (revision, key) => sync.recordConfigRevision(stores.meta, revision, key),
      apply: (next) => replace(next),
      async get() {
        const r = await server.request('GET', `${base}/config`);
        if (r.status !== 200) throw new Error(`GET config: ${r.status}`);
        return r.body;
      },
      async put(request) {
        const r = await server.request('PUT', `${base}/config`, request);
        if (r.status === 409) return { status: 'conflict', ...viewOf(r.body) };
        if (r.status !== 200) throw new Error(`PUT config: ${r.status} ${JSON.stringify(r.body)}`);
        return r.body;
      },
    },
    setRoles: (roles) => replace(storage.parseBrainConfig({ ...client.config, roles })),
    sync: () => coreEngine.runSync(() => client.engine, send, { config: client.io }),
    syncLikeAnOldClient: () =>
      coreEngine.runSync(
        () => client.engine,
        (request) => {
          const { configRevision: _r, ...old } = request;
          return send(old);
        },
      ),
  };
  async function replace(next: storage.BrainConfig): Promise<void> {
    await coreEngine.applyConfigChange({ stores, content, from: client.config, to: next, now });
    client.config = next;
    client.engine = coreEngine.createEngine({ stores, content, config: next, now });
  }
  async function send(request: sync.SyncRequest): Promise<sync.SyncResponse> {
    const r = await server.request('POST', `${base}/sync`, request);
    if (r.status === 409 && r.body?.error?.code === 'config-changed') {
      throw new sync.ConfigChangedError(viewOf(r.body));
    }
    if (r.status !== 200) throw new Error(`sync failed: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as sync.SyncResponse;
  }
  client.engine = coreEngine.createEngine({ stores, content, config: client.config, now });
  return client;
}

const HIDDEN_ROLES = { ...TEST_ROLES, excluded: ['private/', 'memos/hidden/'] };

async function serverSearch(server: TestServer, brainId: string, q: string): Promise<string[]> {
  const r = await server.request('GET', `/api/brains/${brainId}/search?q=${q}&mode=all`);
  return (r.body.results as { path: string }[]).map((x) => x.path);
}

async function idsOf(c: ConfigClient) {
  return {
    events: (await c.stores.events.readAfter(0)).map((e) => e.id).sort(),
    changes: (await c.stores.events.changes()).map((x) => x.id).sort(),
  };
}

describePg('shared config', () => {
  it('reads and replaces the config by revision; a stale base is refused', async () => {
    const server = await testServer();
    await createBrain(server, 'garden');
    const got = await server.request('GET', '/api/brains/garden/config');
    expect(got.status).toBe(200);
    expect(got.body.revision).toBe(1);
    expect(got.body.config.roles).toEqual(TEST_ROLES);
    expect((await server.request('GET', '/api/brains/garden')).body.configRevision).toBe(1);

    const next = { ...got.body.config, alpha: 0.25 };
    const saved = await server.request('PUT', '/api/brains/garden/config', {
      baseRevision: 1,
      config: next,
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ status: 'saved', revision: 2 });

    // The same config again, from a stale base: nothing to refuse.
    const same = await server.request('PUT', '/api/brains/garden/config', {
      baseRevision: 1,
      config: next,
    });
    expect(same.body).toMatchObject({ status: 'unchanged', revision: 2 });

    const stale = await server.request('PUT', '/api/brains/garden/config', {
      baseRevision: 1,
      config: { ...next, alpha: 2 },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('config-conflict');
    expect(stale.body.error.revision).toBe(2);
    expect(stale.body.error.config.alpha).toBe(0.25);

    for (const bad of [
      { baseRevision: 2, config: { ...next, clientId: 'x' } },
      { baseRevision: 2, config: { roles: { memo: 42 } } },
      { baseRevision: -1, config: next },
      { baseRevision: 2, config: next, extra: true },
    ]) {
      expect((await server.request('PUT', '/api/brains/garden/config', bad)).status).toBe(400);
    }
  });

  it(
    'a newly excluded folder leaves every index and stops syncing; nothing is deleted; it comes back',
    { timeout: TIMEOUT },
    async () => {
      const server = await testServer();
      await createBrain(server, 'garden');
      const a = configClient(server, 'garden', 'laptop');
      const b = configClient(server, 'garden', 'phone');
      await a.engine.index();
      await a.engine.saveNote('memos/open.md', '# Open\n\nheron lake, see [[quiet]]\n');
      await a.engine.saveNote('memos/hidden/quiet.md', '# Quiet\n\nheron marsh\n');
      await a.engine.readNote('memos/hidden/quiet.md');
      expect((await a.sync()).config).toBe('in-step');
      await b.sync();
      expect(b.content.snapshot()['memos/hidden/quiet.md']).toContain('heron marsh');

      // An event about the hidden note that the phone never pulled before the change.
      await a.engine.readNote('memos/hidden/quiet.md');
      await a.sync();

      // The laptop excludes the folder; the change is pushed before the sync.
      await a.engine.readNote('memos/hidden/quiet.md');
      await a.setRoles(HIDDEN_ROLES);
      expect((await a.engine.search('heron')).results.map((r) => r.path)).toEqual([
        'memos/open.md',
      ]);
      // A local read logged just before the change is never pushed once excluded.
      const result = await a.sync();
      expect(result.config).toBe('pushed');
      expect((await server.request('GET', '/api/brains/garden/config')).body.revision).toBe(2);
      expect(await serverSearch(server, 'garden', 'heron')).toEqual(['memos/open.md']);
      // The server keeps the note in its repository; the laptop keeps its copy.
      const file = join(server.dataDir, 'brains', 'garden', 'memos/hidden/quiet.md');
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, 'utf8')).toContain('heron marsh');
      expect(a.content.snapshot()['memos/hidden/quiet.md']).toContain('heron marsh');
      expect((await a.engine.syncStatus()).pending.notes).toBe(0);

      // The phone takes the new config on its next sync and keeps its copy too.
      expect((await b.sync()).config).toBe('pulled');
      expect(b.config.roles.excluded).toEqual(HIDDEN_ROLES.excluded);
      expect((await b.engine.search('heron')).results.map((r) => r.path)).toEqual([
        'memos/open.md',
      ]);
      expect(b.content.snapshot()['memos/hidden/quiet.md']).toContain('heron marsh');
      // Saving there is refused now.
      await expect(b.engine.saveNote('memos/hidden/new.md', '# New\n')).rejects.toMatchObject({
        code: 'excluded',
      });

      // A new copy never receives the excluded note or entries naming it.
      const c = configClient(server, 'garden', 'tablet');
      c.config = storage.parseBrainConfig({ clientId: 'tablet', roles: HIDDEN_ROLES });
      c.engine = coreEngine.createEngine({
        stores: c.stores,
        content: c.content,
        config: c.config,
        now: server.now,
      });
      await c.sync();
      expect(Object.keys(c.content.snapshot())).toEqual(['memos/open.md']);
      expect(
        (await c.stores.events.readAfter(0)).some((e) => e.item.startsWith('memos/hidden/')),
      ).toBe(false);

      // The phone accepts the folder again: it comes back everywhere, with its
      // history, and nothing counts as a new edit.
      const editsBefore = (await server.request('GET', '/api/brains/garden/status')).body.events;
      await b.setRoles(TEST_ROLES);
      expect((await b.sync()).config).toBe('pushed');
      expect(await serverSearch(server, 'garden', 'heron')).toEqual(
        expect.arrayContaining(['memos/open.md', 'memos/hidden/quiet.md']),
      );
      expect((await server.request('GET', '/api/brains/garden/status')).body.events).toEqual(
        editsBefore,
      );
      await a.sync();
      await c.sync();
      expect(c.content.snapshot()['memos/hidden/quiet.md']).toContain('heron marsh');
      expect((await c.engine.search('marsh')).results.map((r) => r.path)).toEqual([
        'memos/hidden/quiet.md',
      ]);
      await a.sync();
      await b.sync();
      const ids = await idsOf(b);
      expect(await idsOf(c)).toEqual(ids);
      // The laptop also has the read it logged just before excluding the
      // folder: it was never sent, and stays on the laptop only.
      const laptop = await idsOf(a);
      expect(laptop.changes).toEqual(ids.changes);
      expect(laptop.events.filter((e) => !ids.events.includes(e))).toHaveLength(1);
      expect(ids.events.every((e) => laptop.events.includes(e))).toBe(true);

      // The note's history shows each version once.
      const history = await server.request(
        'GET',
        '/api/brains/garden/notes/memos/hidden/quiet.md/history',
      );
      expect(history.body.versions).toHaveLength(1);
    },
  );

  it(
    'two copies changing the config offline: the second gets a conflict and chooses',
    { timeout: TIMEOUT },
    async () => {
      const server = await testServer();
      await createBrain(server, 'garden');
      const a = configClient(server, 'garden', 'laptop');
      const b = configClient(server, 'garden', 'phone');
      await a.engine.index();
      await a.engine.saveNote('memos/one.md', '# One\n\nmoss\n');
      await a.sync();
      await b.sync();

      await a.setRoles({ ...TEST_ROLES, blog: ['blog/'] });
      await b.setRoles({ ...TEST_ROLES, source: ['sources/', 'library/'] });
      await b.engine.saveNote('memos/two.md', '# Two\n\nfern\n');
      expect((await a.sync()).config).toBe('pushed');

      // The phone's sync stops before anything is sent: neither config is overwritten.
      const error = await b.sync().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(sync.ConfigConflictError);
      const conflict = error as sync.ConfigConflictError;
      expect(conflict.server.revision).toBe(2);
      expect(conflict.server.config.roles).toMatchObject({ blog: ['blog/'] });
      expect(conflict.local.roles).toMatchObject({ source: ['sources/', 'library/'] });
      expect(b.config.roles.source).toEqual(['sources/', 'library/']);
      expect((await server.request('GET', '/api/brains/garden/config')).body.revision).toBe(2);
      expect(await serverSearch(server, 'garden', 'fern')).toEqual([]);

      // Keep the phone's: it replaces the server's, and the laptop takes it.
      expect(await coreEngine.resolveConfigConflict(b.io, 'mine', conflict.server)).toBe('pushed');
      await b.sync();
      expect(await serverSearch(server, 'garden', 'fern')).toEqual(['memos/two.md']);
      expect((await a.sync()).config).toBe('pulled');
      expect(a.config.roles).toEqual(b.config.roles);

      // Again, the other way: take the server's.
      await a.setRoles({ ...TEST_ROLES, blog: ['posts/'] });
      await b.setRoles({ ...TEST_ROLES, blog: ['journal/'] });
      await a.sync();
      const again = (await b.sync().catch((e: unknown) => e)) as sync.ConfigConflictError;
      expect(again).toBeInstanceOf(sync.ConfigConflictError);
      expect(await coreEngine.resolveConfigConflict(b.io, 'theirs', again.server)).toBe('pulled');
      expect(b.config.roles.blog).toEqual(['posts/']);
      expect((await b.sync()).config).toBe('in-step');
    },
  );

  it('a copy that knew no revision and differs is a conflict, not an overwrite', async () => {
    const server = await testServer();
    await createBrain(server, 'garden');
    const a = configClient(server, 'garden', 'laptop');
    await a.setRoles({ memo: ['notes/'] });
    await expect(a.sync()).rejects.toBeInstanceOf(sync.ConfigConflictError);
    expect((await server.request('GET', '/api/brains/garden/config')).body.config.roles).toEqual(
      TEST_ROLES,
    );
  });

  it('a copy from before shared config sync keeps syncing', async () => {
    const server = await testServer();
    await createBrain(server, 'garden');
    const a = configClient(server, 'garden', 'laptop');
    const old = configClient(server, 'garden', 'old-phone');
    await a.engine.index();
    await a.engine.saveNote('memos/one.md', '# One\n\nmoss\n');
    await a.sync();
    await a.setRoles({ ...TEST_ROLES, blog: ['blog/'] });
    await a.sync();
    await old.engine.index();
    await old.engine.saveNote('memos/two.md', '# Two\n\nfern\n');
    const r = await old.syncLikeAnOldClient();
    expect(r.conflicts).toEqual([]);
    expect(Object.keys(old.content.snapshot()).sort()).toEqual(['memos/one.md', 'memos/two.md']);
    // A raw request with a stale revision is refused and applies nothing.
    const stale = await server.request('POST', '/api/brains/garden/sync', {
      since: 0,
      configRevision: 1,
      events: [],
      changes: [],
      edits: [
        {
          id: 'e1',
          op: 'write',
          path: 'memos/three.md',
          baseHash: null,
          text: '# Three\n',
        },
      ],
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: 'config-changed', revision: 2 });
    expect(await serverSearch(server, 'garden', 'three')).toEqual([]);
  });
});
