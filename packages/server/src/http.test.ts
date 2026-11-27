// The HTTP API through its real handler: health, 503 without a database,
// access, brain isolation, input validation and the engine routes. The
// Postgres parts are skipped without SOMEMEMOS_TEST_DATABASE_URL.

import { join } from 'node:path';
import { VERSION } from '@somememos/core';
import { MIGRATIONS } from '@somememos/pg-store';
import { describe, expect, it } from 'vitest';
import { FailureLimiter, hashToken, parseTokens, type Authorizer } from './auth.js';
import { createApp } from './http.js';
import { runGit } from './git.js';
import {
  TEST_ROLES,
  TOKEN,
  createBrain,
  describePg,
  serverConfig,
  testClient,
  testServer,
  tempDir,
  testPool,
} from './test-env.testing.js';

const LATEST = MIGRATIONS.at(-1)?.version;
const quiet = { error: () => undefined, info: () => undefined, warn: () => undefined };

async function call(
  app: ReturnType<typeof createApp>,
  method: string,
  path: string,
  init: RequestInit = {},
) {
  const r = await app.handle(new Request(`http://somememos.test${path}`, { method, ...init }), {
    clientAddress: '10.0.0.1',
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON of any route
  const body: any = await r.json();
  return { status: r.status, body, headers: r.headers };
}

describe('without a database', () => {
  it('reports health with the version and answers the API with 503', async () => {
    const app = createApp({
      config: { ...serverConfig(tempDir()), databaseUrl: null, dataDir: null },
      log: quiet,
    });
    await app.start();
    const health = await call(app, 'GET', '/api/health');
    expect(health.status).toBe(200);
    expect(health.body).toEqual({
      version: VERSION,
      status: 'ok',
      database: { configured: false },
    });
    const brains = await call(app, 'GET', '/api/brains', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(brains.status).toBe(503);
    expect(brains.body.error.code).toBe('no-database');
    expect((await call(app, 'POST', '/api/brains/x/sync')).status).toBe(503);
    expect((await call(app, 'GET', '/api/nowhere')).status).toBe(404);
  });

  it('answers 503 with the problems when the configuration is invalid', async () => {
    const app = createApp({ config: { problems: ['SOMEMEMOS_TOKEN is not set'] }, log: quiet });
    const health = await call(app, 'GET', '/api/health');
    expect(health.status).toBe(503);
    expect(health.body).toMatchObject({
      status: 'misconfigured',
      problems: ['SOMEMEMOS_TOKEN is not set'],
    });
    const api = await call(app, 'GET', '/api/brains');
    expect(api.status).toBe(503);
    expect(api.body.error.code).toBe('server-misconfigured');
  });
});

describePg('the HTTP API', () => {
  it('reports database health and migration state', async () => {
    const server = await testServer();
    const r = await server.request('GET', '/api/health', undefined, { token: null });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      version: VERSION,
      status: 'ok',
      database: {
        configured: true,
        connected: true,
        migration: { current: LATEST, expected: LATEST },
      },
    });
  });

  it('requires a valid token on every route but health, and limits failed attempts', async () => {
    const server = await testServer();
    await createBrain(server, 'locked');
    await server.request('PUT', '/api/brains/locked/notes/memos/a.md', {
      text: '# Secret plans\n',
    });
    const routes: [string, string, unknown?][] = [
      ['GET', '/api/brains'],
      ['POST', '/api/brains', { id: 'other' }],
      ['GET', '/api/brains/locked'],
      ['POST', '/api/brains/locked/sync', { since: 0, events: [], changes: [], edits: [] }],
      ['GET', '/api/brains/locked/search?q=secret'],
      ['GET', '/api/brains/locked/list'],
      ['GET', '/api/brains/locked/notes/memos/a.md'],
      ['PUT', '/api/brains/locked/notes/memos/a.md', { text: 'x' }],
      ['DELETE', '/api/brains/locked/notes/memos/a.md'],
      ['POST', '/api/brains/locked/rename', { from: 'memos/a.md', to: 'memos/b.md' }],
      ['GET', '/api/brains/locked/notes/memos/a.md/history'],
      ['GET', '/api/brains/locked/log'],
      ['GET', '/api/brains/locked/status'],
      ['GET', '/api/brains/locked/titles'],
      ['GET', '/api/brains/locked/dangling'],
      ['GET', '/api/brains/locked/diary'],
    ];
    for (const [method, path, body] of routes) {
      for (const token of [null, 'wrong-token-but-long-enough-1234567']) {
        const r = await server.request(method, path, body, { token });
        expect(r.status, `${method} ${path}`).toBe(401);
        expect(JSON.stringify(r.body)).not.toContain('Secret');
      }
    }
    // The note is still there and unchanged.
    const ok = await server.request('GET', '/api/brains/locked/notes/memos/a.md?record=false');
    expect(ok.body.text).toBe('# Secret plans\n');

    const limited = createApp({
      config: serverConfig(tempDir()),
      pool: server.pool,
      limiter: new FailureLimiter({ perAddress: 3, windowMs: 60_000 }),
      log: quiet,
    });
    for (let i = 0; i < 3; i++) {
      expect(
        (await call(limited, 'GET', '/api/brains', { headers: { authorization: 'Bearer nope' } }))
          .status,
      ).toBe(401);
    }
    const blocked = await call(limited, 'GET', '/api/brains', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('accepts hashed and listed tokens', async () => {
    const pool = await testPool();
    const other = 'another-token-abcdefghijklmnopqrstu';
    const app = createApp({
      config: {
        ...serverConfig(tempDir()),
        tokens: parseTokens(`${hashToken(TOKEN)}, ${other}`).tokens,
      },
      pool,
      log: quiet,
    });
    for (const t of [TOKEN, other]) {
      expect(
        (await call(app, 'GET', '/api/brains', { headers: { authorization: `Bearer ${t}` } }))
          .status,
      ).toBe(200);
    }
    expect(
      (
        await call(app, 'GET', '/api/brains', {
          headers: { authorization: `Bearer ${hashToken(TOKEN)}` },
        })
      ).status,
    ).toBe(401);
  });

  it('keeps brains apart, and each owner sees only their own', async () => {
    const server = await testServer();
    await createBrain(server, 'one');
    await createBrain(server, 'two');
    expect((await server.request('POST', '/api/brains', { id: 'one' })).status).toBe(409);
    await server.request('PUT', '/api/brains/one/notes/memos/orchid.md', {
      text: '# Orchid\n\nRepotting [[bark]].\n',
    });
    expect((await server.request('GET', '/api/brains/two/notes/memos/orchid.md')).status).toBe(404);
    expect(
      (await server.request('GET', '/api/brains/two/search?q=orchid&mode=all')).body.results,
    ).toEqual([]);
    expect((await server.request('GET', '/api/brains/two/titles')).body.notes).toEqual([]);
    expect((await server.request('GET', '/api/brains/two/dangling')).body.dangling).toEqual([]);
    const two = testClient(server, 'two', 'phone');
    await two.sync();
    expect(two.content.snapshot()).toEqual({});
    const list = await server.request('GET', '/api/brains');
    expect(list.body.brains.map((b: { id: string }) => b.id)).toEqual(['one', 'two']);

    // A second user (as real accounts would be) cannot see or reach the owner's brains.
    const byToken: Authorizer = {
      authorize: (req) =>
        req.headers.get('authorization') === 'Bearer someone-else-token-0123456789'
          ? { userId: 'someone-else' }
          : req.headers.get('authorization') === `Bearer ${TOKEN}`
            ? { userId: 'owner' }
            : null,
    };
    const multi = createApp({
      config: serverConfig(server.dataDir),
      pool: server.pool,
      authorizer: byToken,
      log: quiet,
    });
    const as = { headers: { authorization: 'Bearer someone-else-token-0123456789' } };
    expect((await call(multi, 'GET', '/api/brains', as)).body).toEqual({ brains: [] });
    expect((await call(multi, 'GET', '/api/brains/one', as)).status).toBe(404);
    expect((await call(multi, 'GET', '/api/brains/one/notes/memos/orchid.md', as)).status).toBe(
      404,
    );
    expect(
      (
        await call(multi, 'POST', '/api/brains/one/sync', {
          ...as,
          headers: { ...as.headers, 'content-type': 'application/json' },
          body: JSON.stringify({ since: 0, events: [], changes: [], edits: [] }),
        })
      ).status,
    ).toBe(404);
  });

  it('validates every input strictly; an invalid request changes nothing', async () => {
    const server = await testServer();
    await createBrain(server, 'strict');
    const a = testClient(server, 'strict', 'phone');
    await a.engine.index();
    await a.engine.saveNote('memos/ok.md', '# Ok\n');
    await a.sync();
    const before = (await server.request('GET', '/api/brains/strict')).body.mutation;
    const dir = join(server.dataDir, 'brains', 'strict');
    const commits = (await runGit(dir, ['rev-list', '--count', 'HEAD'])).trim();
    const hash = '0'.repeat(64);
    const good = { id: 'e1', op: 'write', path: 'memos/new.md', baseHash: null, text: '# New\n' };
    const bad: [unknown, number, string][] = [
      [
        { since: 0, events: [], changes: [], edits: [{ ...good, path: '../escape.md' }] },
        400,
        'invalid-path',
      ],
      [
        { since: 0, events: [], changes: [], edits: [{ ...good, path: 'memos/../x.md' }] },
        400,
        'invalid-path',
      ],
      [
        { since: 0, events: [], changes: [], edits: [{ ...good, path: '/abs.md' }] },
        400,
        'invalid-path',
      ],
      [
        { since: 0, events: [], changes: [], edits: [{ ...good, path: '.git/config.md' }] },
        400,
        'invalid-path',
      ],
      [
        { since: 0, events: [], changes: [], edits: [{ ...good, path: 'memos/x.txt' }] },
        400,
        'invalid-path',
      ],
      [
        { since: 0, events: [], changes: [], edits: [{ ...good, path: 'private/diary.md' }] },
        403,
        'excluded',
      ],
      [
        { since: 0, events: [], changes: [], edits: [{ ...good, path: 'elsewhere/x.md' }] },
        400,
        'no-role',
      ],
      [
        { since: 0, events: [], changes: [], edits: [good, { ...good, id: 'e2' }] },
        400,
        'invalid-request',
      ],
      [{ since: 0, events: [], changes: [], edits: [good, good] }, 400, 'invalid-request'],
      [
        {
          since: 0,
          events: [],
          changes: [],
          edits: [{ ...good, op: 'delete', baseHash: null, text: undefined }],
        },
        400,
        'invalid-request',
      ],
      [
        { since: 0, events: [], changes: [], edits: [{ ...good, baseHash: 'abc' }] },
        400,
        'invalid-request',
      ],
      [
        {
          since: 0,
          events: [],
          changes: [],
          edits: [{ ...good, text: 'x'.repeat(3 * 1024 * 1024) }],
        },
        413,
        'too-large',
      ],
      [{ since: 0, events: [], changes: [], edits: [good], extra: 1 }, 400, 'invalid-request'],
      [{ since: -1, events: [], changes: [], edits: [] }, 400, 'invalid-request'],
      [
        {
          since: 0,
          events: [
            { id: 'x', kind: 'read', item: 'private/diary.md', time: server.now(), client: 'c' },
          ],
          changes: [],
          edits: [good],
        },
        403,
        'excluded',
      ],
      [
        {
          since: 0,
          events: [
            {
              id: 'x',
              kind: 'read',
              item: 'memos/ok.md',
              time: server.now() + 10_000,
              client: 'c',
            },
          ],
          changes: [],
          edits: [good],
        },
        422,
        'future-event',
      ],
      [
        {
          since: 0,
          events: [{ id: 'x', kind: 'gaze', item: 'memos/ok.md', time: server.now(), client: 'c' }],
          changes: [],
          edits: [good],
        },
        400,
        'invalid-event',
      ],
      [
        {
          since: 0,
          events: [],
          changes: [
            {
              id: 'c',
              time: server.now(),
              client: 'c',
              message: null,
              op: null,
              paths: ['private/x.md'],
            },
          ],
          edits: [good],
        },
        403,
        'excluded',
      ],
      [
        {
          since: 0,
          events: [],
          changes: [],
          edits: [{ ...good, op: 'rename', to: 'memos/new.md', baseHash: hash, text: undefined }],
        },
        400,
        'invalid-request',
      ],
      [{ since: 999_999, events: [], changes: [], edits: [good] }, 409, 'since-ahead'],
      ['not an object', 400, 'invalid-request'],
    ];
    for (const [body, status, code] of bad) {
      const r = await server.request('POST', '/api/brains/strict/sync', body);
      expect([r.status, r.body.error?.code], JSON.stringify(body).slice(0, 120)).toEqual([
        status,
        code,
      ]);
      expect(JSON.stringify(r.body)).not.toContain('private/');
    }
    const raw = await server.app.handle(
      new Request('http://somememos.test/api/brains/strict/sync', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: '{"since": 0,',
      }),
    );
    expect(raw.status).toBe(400);
    const plain = await server.app.handle(
      new Request('http://somememos.test/api/brains/strict/sync', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'text/plain' },
        body: '{}',
      }),
    );
    expect(plain.status).toBe(415);
    const crossOrigin = await server.request('GET', '/api/brains', undefined, {
      headers: { origin: 'https://evil.example' },
    });
    expect(crossOrigin.status).toBe(403);
    expect(
      (
        await server.request('GET', '/api/brains', undefined, {
          headers: { origin: 'http://somememos.test' },
        })
      ).status,
    ).toBe(200);
    expect((await server.request('POST', '/api/brains', { id: 'Bad_Id' })).status).toBe(400);
    expect(
      (await server.request('POST', '/api/brains', { id: 'ok-id', config: { clientId: 'x' } }))
        .status,
    ).toBe(400);
    expect(
      (await server.request('POST', '/api/brains', { id: 'ok-id', config: { roles: { memo: 5 } } }))
        .status,
    ).toBe(400);
    expect((await server.request('GET', '/api/brains/strict/notes/memos%2F..%2Fx.md')).status).toBe(
      400,
    );
    expect((await server.request('GET', '/api/brains/strict/frobnicate')).status).toBe(404);
    expect(
      (
        await server.request('GET', '/api/brains/strict/status', undefined, {
          headers: { 'x-somememos-client': 'bad id!' },
        })
      ).status,
    ).toBe(400);

    expect((await server.request('GET', '/api/brains/strict')).body.mutation).toBe(before);
    expect((await runGit(dir, ['rev-list', '--count', 'HEAD'])).trim()).toBe(commits);
    expect(
      (await server.request('GET', '/api/brains/strict/titles')).body.notes.map(
        (n: { path: string }) => n.path,
      ),
    ).toEqual(['memos/ok.md']);
  });

  it('maps the engine one-to-one over HTTP, with history, past versions and restore', async () => {
    const server = await testServer();
    const r = await server.request('POST', '/api/brains', {
      id: 'routes',
      config: { roles: TEST_ROLES },
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ id: 'routes', mutation: 0 });
    const info = await server.request('GET', '/api/brains/routes');
    expect(info.body.config.roles).toEqual(TEST_ROLES);
    expect(info.body.config.clientId).toBeUndefined();
    const as = { headers: { 'x-somememos-client': 'agent-7' } };
    const b = '/api/brains/routes';

    const v1 = await server.request(
      'PUT',
      `${b}/notes/memos/kiln.md`,
      { text: '# Kiln\n\nCone 6 [[glaze]].\n', baseHash: null, message: 'ingest kiln' },
      as,
    );
    expect(v1.status).toBe(200);
    expect(v1.body).toMatchObject({
      status: 'saved',
      created: true,
      change: { op: 'ingest', client: 'agent-7' },
    });
    server.now.tick();
    const stale = await server.request(
      'PUT',
      `${b}/notes/memos/kiln.md`,
      { text: 'x', baseHash: null },
      as,
    );
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ status: 'conflict', currentHash: v1.body.hash });
    const v2 = await server.request(
      'PUT',
      `${b}/notes/memos/kiln.md`,
      {
        text: '# Kiln\n\nCone 10 [[glaze]] [[shelf]].\n',
        baseHash: v1.body.hash,
        message: 'update firing',
      },
      as,
    );
    expect(v2.body.status).toBe('saved');
    const note = await server.request('GET', `${b}/notes/memos/kiln.md`, undefined, as);
    expect(note.body).toMatchObject({
      path: 'memos/kiln.md',
      hash: v2.body.hash,
      recorded: true,
      role: 'memo',
    });
    const quiet2 = await server.request('GET', `${b}/notes/memos/kiln.md?record=false`);
    expect(quiet2.body.recorded).toBe(false);

    expect(
      (await server.request('GET', `${b}/search?q=cone&mode=all`)).body.results.map(
        (x: { path: string }) => x.path,
      ),
    ).toEqual(['memos/kiln.md']);
    expect((await server.request('GET', `${b}/search?q=cone&mode=warm`)).status).toBe(400);
    expect(
      (await server.request('GET', `${b}/list?mode=hot&limit=5`)).body.results.map(
        (x: { item: string }) => x.item,
      ),
    ).toContain('memos/kiln.md');
    expect(
      (await server.request('GET', `${b}/dangling`)).body.dangling
        .map((d: { key: string }) => d.key)
        .sort(),
    ).toEqual(['glaze', 'shelf']);
    expect((await server.request('GET', `${b}/titles`)).body.notes).toEqual([
      { path: 'memos/kiln.md', title: 'Kiln', role: 'memo', date: null, published: null },
    ]);
    const status = await server.request('GET', `${b}/status`, undefined, as);
    expect(status.body).toMatchObject({
      clientId: 'agent-7',
      notes: { total: 1 },
      events: { read: 1, edit: 2 },
    });
    expect(
      (await server.request('GET', `${b}/log`)).body.changes.map(
        (c: { message: string }) => c.message,
      ),
    ).toEqual(['update firing', 'ingest kiln']);
    expect((await server.request('GET', `${b}/log?op=ingest&limit=1`)).body.changes).toHaveLength(
      1,
    );

    const day = await server.request('GET', `${b}/diary?date=2027-01-15`);
    expect(day.body).toEqual({ path: 'diary/2027/01/2027-01-15.md', date: '2027-01-15' });
    expect((await server.request('POST', `${b}/diary`, { date: '2027-01-15' })).body.created).toBe(
      true,
    );
    expect((await server.request('POST', `${b}/diary`, { date: '2027-01-15' })).body.created).toBe(
      false,
    );
    expect((await server.request('GET', `${b}/status`)).body.uncommitted).toEqual([]);
    const diaryLog = await server.request('GET', `${b}/log?all=true&limit=1`);
    expect(diaryLog.body.changes[0].paths).toEqual(['diary/2027/01/2027-01-15.md']);
    expect((await server.request('GET', `${b}/diary?date=2027-02-30`)).status).toBe(400);

    // History, a past version, and restoring it as a new commit.
    server.now.tick();
    const moved = await server.request(
      'POST',
      `${b}/rename`,
      { from: 'memos/kiln.md', to: 'memos/kilns/electric.md', message: 'update move' },
      as,
    );
    expect(moved.body).toMatchObject({ status: 'renamed', to: 'memos/kilns/electric.md' });
    expect(
      (await server.request('POST', `${b}/rename`, { from: 'memos/kiln.md', to: 'memos/x.md' }))
        .status,
    ).toBe(404);
    const history = await server.request('GET', `${b}/notes/memos/kilns/electric.md/history`);
    expect(history.status).toBe(200);
    const versions = history.body.versions as {
      path: string;
      hash: string | null;
      commit: string;
      message: string;
      client: string;
      time: number;
    }[];
    expect(versions.map((v) => [v.path, v.message, v.client])).toEqual([
      ['memos/kilns/electric.md', 'update move', 'agent-7'],
      ['memos/kiln.md', 'update move', 'agent-7'],
      ['memos/kiln.md', 'update firing', 'agent-7'],
      ['memos/kiln.md', 'ingest kiln', 'agent-7'],
    ]);
    const first = versions[3] as (typeof versions)[number];
    expect(first.hash).toBe(v1.body.hash);
    const past = await server.request('GET', `${b}/notes/memos/kiln.md/versions/${first.commit}`);
    expect(past.body).toEqual({
      path: 'memos/kiln.md',
      commit: first.commit,
      hash: v1.body.hash,
      text: '# Kiln\n\nCone 6 [[glaze]].\n',
    });
    const byHash = await server.request(
      'GET',
      `${b}/notes/memos/kiln.md/versions?hash=${v1.body.hash}`,
    );
    expect(byHash.body.commit).toBe(first.commit);
    expect(
      (await server.request('GET', `${b}/notes/memos/kilns/electric.md/versions/${first.commit}`))
        .status,
    ).toBe(404);
    const restored = await server.request(
      'POST',
      `${b}/notes/memos/kilns/electric.md/restore`,
      { commit: versions[0]?.commit },
      as,
    );
    expect(restored.body.status).toBe('unchanged');
    const dir = join(server.dataDir, 'brains', 'routes');
    const count = Number((await runGit(dir, ['rev-list', '--count', 'HEAD'])).trim());
    const restore = await server.request(
      'POST',
      `${b}/notes/memos/kiln.md/restore`,
      { commit: first.commit, baseHash: null },
      as,
    );
    expect(restore.body).toMatchObject({ status: 'saved', created: true });
    expect(Number((await runGit(dir, ['rev-list', '--count', 'HEAD'])).trim())).toBe(count + 1);
    expect((await runGit(dir, ['log', '-1', '--format=%s'])).trim()).toMatch(
      /^restore memos\/kiln\.md/,
    );

    // Errors: codes and statuses, never naming an excluded path.
    const excluded = await server.request('GET', `${b}/notes/private/plans.md`);
    expect(excluded.status).toBe(403);
    expect(excluded.body.error.code).toBe('excluded');
    expect(JSON.stringify(excluded.body)).not.toContain('plans');
    expect((await server.request('GET', `${b}/notes/private/plans.md/history`)).status).toBe(403);
    expect((await server.request('PUT', `${b}/notes/private/plans.md`, { text: 'x' })).status).toBe(
      403,
    );
    expect((await server.request('GET', `${b}/notes/memos/none.md`)).body.error).toMatchObject({
      code: 'not-found',
      path: 'memos/none.md',
    });
    expect(
      (
        await server.request('POST', `${b}/rename`, {
          from: 'memos/kiln.md',
          to: 'memos/kilns/electric.md',
        })
      ).status,
    ).toBe(409);
    await server.request('PUT', `${b}/notes/sources/paper.md`, { text: '# Paper\n' });
    const immutable = await server.request('PUT', `${b}/notes/sources/paper.md`, {
      text: '# Paper\n\nedited\n',
    });
    expect([immutable.status, immutable.body.error.code]).toEqual([409, 'source-immutable']);
    const del = await server.request(
      'DELETE',
      `${b}/notes/memos/kilns/electric.md?message=lint%20drop`,
    );
    expect(del.body).toMatchObject({ status: 'deleted', change: { op: 'lint' } });
    expect((await server.request('PATCH', `${b}/notes/memos/kiln.md`, { text: 'x' })).status).toBe(
      405,
    );
  });
});
