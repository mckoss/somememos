// Crash safety of the write path (./brains.ts): git commits first, the
// database commit is the single commit point, and the next request puts the
// repository back to the commit the database recorded.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPgStores } from '@somememos/pg-store';
import { expect, it } from 'vitest';
import { BrainRepo, ORPHAN_REF_PREFIX, runGit } from './git.js';
import { createGitContentStore } from './git-content.js';
import { createBrain, describePg, testClient, testServer } from './test-env.testing.js';

describePg('crash safety', () => {
  it(
    'recovers when the process fails between the git commit and the database commit',
    { timeout: 60_000 },
    async () => {
      let crash = false;
      const server = await testServer({
        beforeDatabaseCommit: () => {
          if (crash) throw new Error('simulated crash after the git commit');
        },
      });
      await createBrain(server, 'fragile');
      const dir = join(server.dataDir, 'brains', 'fragile');
      const repo = new BrainRepo(dir);
      const a = testClient(server, 'fragile', 'phone');
      await a.engine.index();
      await a.engine.saveNote('memos/one.md', '# One\n');
      await a.sync();
      const recorded = await repo.head();
      const before = (await server.request('GET', '/api/brains/fragile')).body.mutation;

      server.now.tick();
      await a.engine.saveNote('memos/two.md', '# Two\n\nlinks [[one]]\n', {
        message: 'ingest two',
      });
      crash = true;
      await expect(a.sync()).rejects.toThrow(/500/);
      crash = false;

      // Nothing the request did is in the database; the repository is back
      // at the recorded commit, and the commit it made is kept under a ref.
      expect((await server.request('GET', '/api/brains/fragile')).body.mutation).toBe(before);
      const stores = await createPgStores({
        pool: server.pool,
        brainId: 'fragile',
        now: server.now,
      });
      expect((await stores.events.readAfter(0)).some((e) => e.item === 'memos/two.md')).toBe(false);
      expect(await repo.head()).toBe(recorded);
      expect(await repo.isClean()).toBe(true);
      const kept = (
        await runGit(dir, ['for-each-ref', '--format=%(refname)', ORPHAN_REF_PREFIX])
      ).trim();
      expect(kept.split('\n')).toHaveLength(1);
      expect((await server.request('GET', '/api/brains/fragile/notes/memos/two.md')).status).toBe(
        404,
      );

      // The client retries: everything applies once.
      const retry = await a.sync();
      expect(retry.conflicts).toEqual([]);
      expect(
        (await server.request('GET', '/api/brains/fragile/notes/memos/two.md?record=false')).body
          .text,
      ).toBe('# Two\n\nlinks [[one]]\n');
      const ids = (await stores.events.readAfter(0)).map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.sort()).toEqual((await a.stores.events.readAfter(0)).map((e) => e.id).sort());
      expect((await runGit(dir, ['log', '-1', '--format=%s'])).trim()).toBe('ingest two');
    },
  );

  it(
    'recovers from a process that died after committing to git, mid-write',
    { timeout: 60_000 },
    async () => {
      const server = await testServer();
      await createBrain(server, 'killed');
      const dir = join(server.dataDir, 'brains', 'killed');
      await server.request('PUT', '/api/brains/killed/notes/memos/kept.md', { text: '# Kept\n' });
      const repo = new BrainRepo(dir);
      const recorded = await repo.head();

      // What a server killed mid-request leaves behind: a commit the database
      // never recorded, and a half-written working tree on top of it.
      const content = createGitContentStore(dir);
      await content.write('memos/kept.md', '# Kept\n\nchanged by a dead process\n');
      await content.write('memos/ghost.md', '# Ghost\n');
      await repo.stageAll();
      const lost = await repo.commit(
        { author: 'ghost', time: server.now(), message: 'never recorded' },
        server.now(),
      );
      writeFileSync(join(dir, 'memos', 'half.md'), '# Half');

      // The next request (from any process) recovers first.
      const titles = await server.request('GET', '/api/brains/killed/titles');
      expect(titles.body.notes.map((n: { path: string }) => n.path)).toEqual(['memos/kept.md']);
      expect(await repo.head()).toBe(recorded);
      expect(await content.read('memos/kept.md')).toBe('# Kept\n');
      expect(await content.read('memos/ghost.md')).toBeUndefined();
      expect(await content.read('memos/half.md')).toBeUndefined();
      expect((await runGit(dir, ['rev-parse', `${ORPHAN_REF_PREFIX}${lost}`])).trim()).toBe(lost);

      // And writes carry on from the recorded commit.
      const saved = await server.request('PUT', '/api/brains/killed/notes/memos/new.md', {
        text: '# New\n',
      });
      expect(saved.body.status).toBe('saved');
      expect((await runGit(dir, ['rev-list', '--count', 'HEAD'])).trim()).toBe('2');
      const b = testClient(server, 'killed', 'laptop');
      await b.sync();
      expect(b.content.snapshot()).toEqual({
        'memos/kept.md': '# Kept\n',
        'memos/new.md': '# New\n',
      });
    },
  );
});
