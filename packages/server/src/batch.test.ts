// One change set from a remote client (./batch.ts) through the real HTTP
// handler, against Postgres and a git repository: all or none, one change
// record, one git commit, one range of mutation numbers. Invented content.

import { join } from 'node:path';
import { storage } from '@somememos/core';
import { expect, it } from 'vitest';
import { runGit } from './git.js';
import { type TestServer, createBrain, describePg, testServer } from './test-env.testing.js';

const hashOf = (text: string) => storage.contentHash(text);

async function put(server: TestServer, path: string, text: string) {
  const r = await server.request('PUT', `/api/brains/garden/notes/${path}`, { text });
  expect(r.status).toBe(200);
}

async function commitCount(server: TestServer): Promise<number> {
  const out = await runGit(join(server.dataDir, 'brains', 'garden'), [
    'rev-list',
    '--count',
    'HEAD',
  ]);
  return Number(out.trim());
}

describePg('change sets', () => {
  it('applies writes, a delete and a rename as one change, one commit, one mutation range', async () => {
    const server = await testServer();
    await createBrain(server, 'garden');
    await put(server, 'memos/a.md', '# A\n');
    await put(server, 'memos/b.md', '# B\n');
    await put(server, 'memos/c.md', '# C\n');
    const commitsBefore = await commitCount(server);
    const changesBefore = (await server.request('GET', '/api/brains/garden/log?all=true')).body
      .changes.length;
    const before = (await server.request('GET', '/api/brains/garden')).body.mutation;

    const r = await server.request('POST', '/api/brains/garden/changes', {
      message: 'update three notes at once',
      ops: [
        {
          op: 'write',
          path: 'memos/a.md',
          text: '# A\n\nmore, see [[b]]\n',
          baseHash: await hashOf('# A\n'),
        },
        { op: 'write', path: 'memos/new.md', text: '# New\n', baseHash: null },
        { op: 'delete', path: 'memos/b.md', baseHash: await hashOf('# B\n') },
        { op: 'rename', path: 'memos/c.md', to: 'memos/sea.md', baseHash: await hashOf('# C\n') },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('saved');
    expect(r.body.results.map((x: { status: string }) => x.status)).toEqual([
      'applied',
      'applied',
      'applied',
      'applied',
    ]);
    expect(r.body.change.message).toBe('update three notes at once');
    expect([...r.body.change.paths].sort()).toEqual([
      'memos/a.md',
      'memos/b.md',
      'memos/c.md',
      'memos/new.md',
      'memos/sea.md',
    ]);
    expect(await commitCount(server)).toBe(commitsBefore + 1);
    const log = (await server.request('GET', '/api/brains/garden/log?all=true')).body.changes;
    expect(log.length).toBe(changesBefore + 1);
    const titles = (await server.request('GET', '/api/brains/garden/titles')).body.notes.map(
      (n: { path: string }) => n.path,
    );
    expect(titles).toEqual(['memos/a.md', 'memos/new.md', 'memos/sea.md']);
    // The note versions took consecutive mutation numbers in one commit.
    const { rows } = await server.pool.query<{ mutation: string; commit: string }>(
      'SELECT mutation, commit FROM note_versions WHERE brain_id = $1 AND mutation > $2 ORDER BY mutation',
      ['garden', before],
    );
    expect(new Set(rows.map((x) => x.commit)).size).toBe(1);
    const ms = [...new Set(rows.map((x) => Number(x.mutation)))];
    expect(ms).toEqual(ms.map((_, i) => (ms[0] as number) + i));

    // The same request again: nothing new.
    const again = await server.request('POST', '/api/brains/garden/changes', {
      ops: [{ op: 'write', path: 'memos/new.md', text: '# New\n', baseHash: null }],
    });
    expect(again.body).toMatchObject({ status: 'saved', change: null });
    expect(await commitCount(server)).toBe(commitsBefore + 1);
  });

  it('a stale base on one file refuses the whole set and returns every stale version', async () => {
    const server = await testServer();
    await createBrain(server, 'garden');
    await put(server, 'memos/a.md', '# A\n');
    await put(server, 'memos/b.md', '# B, changed elsewhere\n');
    const commits = await commitCount(server);
    const r = await server.request('POST', '/api/brains/garden/changes', {
      message: 'should not land',
      ops: [
        { op: 'write', path: 'memos/a.md', text: '# A2\n', baseHash: await hashOf('# A\n') },
        { op: 'write', path: 'memos/b.md', text: '# B2\n', baseHash: await hashOf('# B\n') },
        { op: 'write', path: 'memos/fresh.md', text: '# Fresh\n', baseHash: null },
      ],
    });
    expect(r.status).toBe(409);
    expect(r.body.status).toBe('conflict');
    expect(r.body.conflicts).toEqual([
      {
        path: 'memos/b.md',
        currentHash: await hashOf('# B, changed elsewhere\n'),
        currentText: '# B, changed elsewhere\n',
      },
    ]);
    expect(await commitCount(server)).toBe(commits);
    const a = await server.request('GET', '/api/brains/garden/notes/memos/a.md?record=false');
    expect(a.body.text).toBe('# A\n');
    expect(
      (await server.request('GET', '/api/brains/garden/notes/memos/fresh.md?record=false')).status,
    ).toBe(404);
  });

  it('refuses invalid sets before anything runs', async () => {
    const server = await testServer();
    await createBrain(server, 'garden');
    const post = (body: unknown) => server.request('POST', '/api/brains/garden/changes', body);
    expect((await post({ ops: [] })).status).toBe(400);
    expect(
      (await post({ ops: [{ op: 'write', path: '../x.md', text: '', baseHash: null }] })).status,
    ).toBe(400);
    expect(
      (
        await post({
          ops: [
            { op: 'write', path: 'memos/x.md', text: 'a', baseHash: null },
            { op: 'delete', path: 'memos/x.md', baseHash: await hashOf('a') },
          ],
        })
      ).status,
    ).toBe(400);
    expect(
      (await post({ ops: [{ op: 'write', path: 'private/x.md', text: 'a', baseHash: null }] }))
        .status,
    ).toBe(403);
    expect((await post({ ops: [{ op: 'move', path: 'memos/x.md' }] })).status).toBe(400);
  });
});
