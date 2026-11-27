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
      limiter: new FailureLimiter({ perAddress: 3, total: 5, windowMs: 60_000, spacingMs: 50 }),
      log: quiet,
    });
    const from = async (address: string, token: string) => {
      const r = await limited.handle(
        new Request('http://somememos.test/api/brains', {
          headers: { authorization: `Bearer ${token}` },
        }),
        { clientAddress: address },
      );
      return { status: r.status, retryAfter: r.headers.get('retry-after') };
    };
    for (let i = 0; i < 2; i++) expect((await from('10.0.0.1', 'nope')).status).toBe(401);
    // The third failure reaches the address's limit: from now on its failures answer 429…
    const third = await from('10.0.0.1', 'nope');
    expect(third.status).toBe(429);
    expect(Number(third.retryAfter)).toBeGreaterThan(0);
    // …and its requests are spaced out before the token is even compared…
    const started = Date.now();
    expect((await from('10.0.0.1', 'nope')).status).toBe(429);
    expect((await from('10.0.0.1', 'nope')).status).toBe(429);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    // …but the right token still gets in, from that address too.
    expect((await from('10.0.0.1', TOKEN)).status).toBe(200);
    // Others' failures reach the total limit: the owner on a clean address is untouched.
    expect((await from('10.0.0.9', 'nope')).status).toBe(429);
    const owner = Date.now();
    expect((await from('10.0.0.2', TOKEN)).status).toBe(200);
    expect(Date.now() - owner).toBeLessThan(45);
    // A fresh address gets one unthrottled guess past the total, then is throttled.
    expect((await from('10.0.0.3', 'nope')).status).toBe(429);
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

  it(
    'pins every route’s accepted and refused inputs; a refused request changes nothing',
    { timeout: 60_000 },
    async () => {
      const server = await testServer();
      await createBrain(server, 'pins');
      const a = testClient(server, 'pins', 'phone');
      await a.engine.index();
      await a.engine.saveNote('memos/ok.md', '# Ok\n');
      await a.sync();
      const b = '/api/brains/pins';
      const dir = join(server.dataDir, 'brains', 'pins');
      const before = (await server.request('GET', b)).body.mutation;
      const commits = (await runGit(dir, ['rev-list', '--count', 'HEAD'])).trim();
      const okHash = (await server.request('GET', `${b}/notes/memos/ok.md?record=false`)).body.hash;
      const hash = '0'.repeat(64);
      const now = server.now();
      const write = { op: 'write', path: 'memos/new.md', text: '# New\n', baseHash: null };
      const edit = { id: 'e1', ...write };
      const event = { id: 'v1', kind: 'read', item: 'memos/ok.md', time: now, client: 'c' };
      const change = { id: 'c1', time: now, client: 'c', message: null, op: null, paths: [] };
      const sync = (extra: object) => ({ since: 0, ...extra });
      const big = 'x'.repeat(2 * 1024 * 1024 + 1);
      const deep = (n: number) => `${'['.repeat(n)}${']'.repeat(n)}`;

      // [method, path, body (a string is sent as raw JSON text), status, code]
      type Case = [string, string, unknown, number, string];
      const raw = (text: string) => ({ raw: text });
      const cases: Case[] = [
        // POST /api/brains
        ['POST', '/api/brains', 'x', 400, 'invalid-request'],
        ['POST', '/api/brains', [], 400, 'invalid-request'],
        ['POST', '/api/brains', null, 400, 'invalid-request'],
        ['POST', '/api/brains', { id: 'fresh', extra: 1 }, 400, 'invalid-request'],
        ['POST', '/api/brains', raw('{"id":"fresh","__proto__":{"x":1}}'), 400, 'invalid-request'],
        ['POST', '/api/brains', raw('{"id":"fresh","constructor":{}}'), 400, 'invalid-request'],
        ['POST', '/api/brains', {}, 400, 'invalid-brain-id'],
        ['POST', '/api/brains', { id: 5 }, 400, 'invalid-brain-id'],
        ['POST', '/api/brains', { id: 'Bad_Id' }, 400, 'invalid-brain-id'],
        ['POST', '/api/brains', { id: 'a'.repeat(64) }, 400, 'invalid-brain-id'],
        ['POST', '/api/brains', { id: '-lead' }, 400, 'invalid-brain-id'],
        ['POST', '/api/brains', { id: 'pins' }, 409, 'brain-exists'],
        ['POST', '/api/brains', { id: 'fresh', config: { clientId: 'x' } }, 400, 'invalid-config'],
        [
          'POST',
          '/api/brains',
          { id: 'fresh', config: { roles: { memo: 5 } } },
          400,
          'invalid-config',
        ],
        ['POST', '/api/brains', { id: 'fresh', config: [] }, 400, 'invalid-config'],
        ['POST', '/api/brains', { id: 'fresh', config: 'x' }, 400, 'invalid-config'],
        ['POST', '/api/brains', { id: 'fresh', config: { frob: 1 } }, 400, 'invalid-config'],
        [
          'POST',
          '/api/brains',
          raw(`{"id":"fresh","config":{"roles":${deep(5000)}}}`),
          400,
          'invalid-config',
        ],

        // PUT …/config
        ['PUT', `${b}/config`, 'x', 400, 'invalid-request'],
        ['PUT', `${b}/config`, [], 400, 'invalid-request'],
        ['PUT', `${b}/config`, { baseRevision: 1, config: {}, x: 1 }, 400, 'invalid-request'],
        [
          'PUT',
          `${b}/config`,
          raw('{"baseRevision":1,"config":{},"__proto__":{}}'),
          400,
          'invalid-request',
        ],
        ['PUT', `${b}/config`, { baseRevision: -1, config: {} }, 400, 'invalid-argument'],
        ['PUT', `${b}/config`, { baseRevision: 1.5, config: {} }, 400, 'invalid-argument'],
        ['PUT', `${b}/config`, { baseRevision: '1', config: {} }, 400, 'invalid-argument'],
        ['PUT', `${b}/config`, { baseRevision: 2 ** 53, config: {} }, 400, 'invalid-argument'],
        ['PUT', `${b}/config`, raw('{"baseRevision":1e400,"config":{}}'), 400, 'invalid-argument'],
        ['PUT', `${b}/config`, { config: {} }, 400, 'invalid-argument'],
        ['PUT', `${b}/config`, { baseRevision: 1 }, 400, 'invalid-argument'],
        ['PUT', `${b}/config`, { baseRevision: 1, config: null }, 400, 'invalid-argument'],
        [
          'PUT',
          `${b}/config`,
          { baseRevision: 1, config: { clientId: 'x' } },
          400,
          'invalid-config',
        ],
        ['PUT', `${b}/config`, { baseRevision: 1, config: { roles: 'x' } }, 400, 'invalid-config'],
        ['PUT', `${b}/config`, { baseRevision: 1, config: [] }, 400, 'invalid-config'],

        // PUT …/blog
        ['PUT', `${b}/blog`, 'x', 400, 'invalid-request'],
        ['PUT', `${b}/blog`, [], 400, 'invalid-request'],
        ['PUT', `${b}/blog`, { enabled: false, x: 1 }, 400, 'invalid-request'],
        ['PUT', `${b}/blog`, raw('{"enabled":false,"constructor":1}'), 400, 'invalid-request'],
        ['PUT', `${b}/blog`, {}, 400, 'invalid-argument'],
        ['PUT', `${b}/blog`, { enabled: 'yes' }, 400, 'invalid-argument'],
        ['PUT', `${b}/blog`, { enabled: 1 }, 400, 'invalid-argument'],
        ['PUT', `${b}/blog`, { enabled: false, slug: 'A' }, 400, 'invalid-slug'],
        ['PUT', `${b}/blog`, { enabled: false, slug: 'api' }, 400, 'invalid-slug'],
        ['PUT', `${b}/blog`, { enabled: false, slug: 5 }, 400, 'invalid-slug'],
        ['PUT', `${b}/blog`, { enabled: false, slug: 'a--b' }, 400, 'invalid-slug'],
        ['PUT', `${b}/blog`, { enabled: false, slug: 'a'.repeat(41) }, 400, 'invalid-slug'],
        ['PUT', `${b}/blog`, { enabled: false, title: 5 }, 400, 'invalid-argument'],
        ['PUT', `${b}/blog`, { enabled: false, title: 'x'.repeat(121) }, 400, 'invalid-argument'],
        ['PUT', `${b}/blog`, { enabled: false, title: 'a\nb' }, 400, 'invalid-argument'],
        ['PUT', `${b}/blog`, { enabled: false, title: 'a b' }, 400, 'invalid-argument'],
        [
          'PUT',
          `${b}/blog`,
          { enabled: false, description: 'x'.repeat(301) },
          400,
          'invalid-argument',
        ],
        ['PUT', `${b}/blog`, { enabled: false, author: 'x'.repeat(101) }, 400, 'invalid-argument'],
        ['PUT', `${b}/blog`, { enabled: false, author: ['x'] }, 400, 'invalid-argument'],
        ['PUT', `${b}/blog`, { enabled: false, language: 'english' }, 400, 'invalid-argument'],
        ['PUT', `${b}/blog`, { enabled: false, language: 5 }, 400, 'invalid-argument'],
        ['PUT', `${b}/blog`, { enabled: true, slug: 'my-blog' }, 400, 'invalid-argument'],
        ['PUT', `${b}/blog`, { enabled: true, title: 'T' }, 400, 'invalid-argument'],
        [
          'PUT',
          `${b}/blog`,
          { enabled: true, slug: 'my-blog', title: '   ' },
          400,
          'invalid-argument',
        ],
        ['GET', `${b}/blog/address`, undefined, 400, 'invalid-path'],
        ['GET', `${b}/blog/address?path=..%2Fx.md`, undefined, 400, 'invalid-path'],

        // POST …/changes
        ['POST', `${b}/changes`, 'x', 400, 'invalid-request'],
        ['POST', `${b}/changes`, {}, 400, 'invalid-request'],
        ['POST', `${b}/changes`, { ops: [] }, 400, 'invalid-request'],
        ['POST', `${b}/changes`, { ops: {} }, 400, 'invalid-request'],
        ['POST', `${b}/changes`, { ops: [write], x: 1 }, 400, 'invalid-request'],
        [
          'POST',
          `${b}/changes`,
          raw(`{"ops":[${JSON.stringify(write)}],"__proto__":{}}`),
          400,
          'invalid-request',
        ],
        ['POST', `${b}/changes`, { message: 5, ops: [write] }, 400, 'invalid-request'],
        [
          'POST',
          `${b}/changes`,
          { message: 'x'.repeat(20_001), ops: [write] },
          400,
          'invalid-request',
        ],
        ['POST', `${b}/changes`, { ops: Array(1001).fill(0) }, 413, 'too-large'],
        ['POST', `${b}/changes`, { ops: [5] }, 400, 'invalid-request'],
        ['POST', `${b}/changes`, { ops: [[write]] }, 400, 'invalid-request'],
        ['POST', `${b}/changes`, { ops: [{ ...write, op: 'frob' }] }, 400, 'invalid-request'],
        ['POST', `${b}/changes`, { ops: [{ ...write, text: undefined }] }, 400, 'invalid-request'],
        ['POST', `${b}/changes`, { ops: [{ ...write, text: 5 }] }, 400, 'invalid-request'],
        ['POST', `${b}/changes`, { ops: [{ ...write, text: big }] }, 413, 'too-large'],
        ['POST', `${b}/changes`, { ops: [{ ...write, to: 'memos/b.md' }] }, 400, 'invalid-request'],
        ['POST', `${b}/changes`, { ops: [{ ...write, baseHash: 'abc' }] }, 400, 'invalid-request'],
        [
          'POST',
          `${b}/changes`,
          { ops: [{ ...write, baseHash: undefined }] },
          400,
          'invalid-request',
        ],
        ['POST', `${b}/changes`, { ops: [{ ...write, extra: 1 }] }, 400, 'invalid-request'],
        ['POST', `${b}/changes`, { ops: [{ ...write, path: '../x.md' }] }, 400, 'invalid-path'],
        ['POST', `${b}/changes`, { ops: [{ ...write, path: 5 }] }, 400, 'invalid-path'],
        ['POST', `${b}/changes`, { ops: [{ ...write, path: undefined }] }, 400, 'invalid-path'],
        ['POST', `${b}/changes`, { ops: [write, write] }, 400, 'invalid-request'],
        [
          'POST',
          `${b}/changes`,
          { ops: [{ op: 'delete', path: 'memos/ok.md', baseHash: null }] },
          400,
          'invalid-request',
        ],
        [
          'POST',
          `${b}/changes`,
          { ops: [{ op: 'delete', path: 'memos/ok.md', baseHash: hash, text: '' }] },
          400,
          'invalid-request',
        ],
        [
          'POST',
          `${b}/changes`,
          { ops: [{ op: 'delete', path: 'memos/ok.md', baseHash: hash, to: 'memos/b.md' }] },
          400,
          'invalid-request',
        ],
        [
          'POST',
          `${b}/changes`,
          { ops: [{ op: 'rename', path: 'memos/ok.md', baseHash: hash }] },
          400,
          'invalid-path',
        ],
        [
          'POST',
          `${b}/changes`,
          { ops: [{ op: 'rename', path: 'memos/ok.md', to: 'memos/ok.md', baseHash: hash }] },
          400,
          'invalid-request',
        ],
        ['POST', `${b}/changes`, { ops: [{ ...write, path: 'private/x.md' }] }, 403, 'excluded'],
        ['POST', `${b}/changes`, { ops: [{ ...write, path: 'elsewhere/x.md' }] }, 404, 'not-found'],

        // POST …/sync
        ['POST', `${b}/sync`, 'x', 400, 'invalid-request'],
        ['POST', `${b}/sync`, [], 400, 'invalid-request'],
        ['POST', `${b}/sync`, {}, 400, 'invalid-request'],
        ['POST', `${b}/sync`, { since: '0' }, 400, 'invalid-request'],
        ['POST', `${b}/sync`, { since: 1.5 }, 400, 'invalid-request'],
        ['POST', `${b}/sync`, { since: 2 ** 53 }, 400, 'invalid-request'],
        ['POST', `${b}/sync`, raw('{"since":1e400}'), 400, 'invalid-request'],
        ['POST', `${b}/sync`, { since: null }, 400, 'invalid-request'],
        ['POST', `${b}/sync`, sync({ client: 'bad id!' }), 400, 'invalid-request'],
        ['POST', `${b}/sync`, sync({ client: 5 }), 400, 'invalid-request'],
        ['POST', `${b}/sync`, sync({ client: 'x'.repeat(101) }), 400, 'invalid-request'],
        ['POST', `${b}/sync`, sync({ configRevision: -1 }), 400, 'invalid-request'],
        ['POST', `${b}/sync`, sync({ configRevision: '1' }), 400, 'invalid-request'],
        ['POST', `${b}/sync`, sync({ events: {} }), 400, 'invalid-request'],
        ['POST', `${b}/sync`, sync({ edits: 'x' }), 400, 'invalid-request'],
        ['POST', `${b}/sync`, sync({ changes: null }), 400, 'invalid-request'],
        ['POST', `${b}/sync`, sync({ events: Array(20_001).fill(0) }), 400, 'too-large'],
        ['POST', `${b}/sync`, sync({ changes: Array(5001).fill(0) }), 400, 'too-large'],
        ['POST', `${b}/sync`, sync({ edits: Array(1001).fill(0) }), 400, 'too-large'],
        ['POST', `${b}/sync`, raw('{"since":0,"__proto__":{"edits":[]}}'), 400, 'invalid-request'],
        ['POST', `${b}/sync`, raw(`{"since":0,"edits":[${deep(10_000)}]}`), 400, 'invalid-request'],
        ['POST', `${b}/sync`, sync({ edits: [5] }), 400, 'invalid-request'],
        ['POST', `${b}/sync`, sync({ edits: [[]] }), 400, 'invalid-request'],
        ['POST', `${b}/sync`, sync({ events: [[]] }), 400, 'invalid-request'],
        ['POST', `${b}/sync`, sync({ changes: [[]] }), 400, 'invalid-request'],
        [
          'POST',
          `${b}/sync`,
          sync({ changes: [{ ...change, paths: [[]] }] }),
          400,
          'invalid-event',
        ],
        ['POST', `${b}/sync`, sync({ edits: [{ ...edit, id: '' }] }), 400, 'invalid-request'],
        [
          'POST',
          `${b}/sync`,
          sync({ edits: [{ ...edit, id: 'x'.repeat(129) }] }),
          400,
          'invalid-request',
        ],
        ['POST', `${b}/sync`, sync({ edits: [{ ...edit, id: 5 }] }), 400, 'invalid-request'],
        ['POST', `${b}/sync`, sync({ edits: [{ ...edit, op: 'frob' }] }), 400, 'invalid-request'],
        [
          'POST',
          `${b}/sync`,
          sync({ edits: [{ ...edit, op: undefined }] }),
          400,
          'invalid-request',
        ],
        ['POST', `${b}/sync`, sync({ edits: [{ ...edit, extra: 1 }] }), 400, 'invalid-request'],
        [
          'POST',
          `${b}/sync`,
          raw(
            `{"since":0,"edits":[{"id":"e1","op":"write","path":"memos/n.md","baseHash":null,"text":"","constructor":1}]}`,
          ),
          400,
          'invalid-request',
        ],
        ['POST', `${b}/sync`, sync({ edits: [{ ...edit, path: undefined }] }), 400, 'invalid-path'],
        ['POST', `${b}/sync`, sync({ edits: [{ ...edit, path: 5 }] }), 400, 'invalid-path'],
        ['POST', `${b}/sync`, sync({ edits: [{ ...edit, path: '' }] }), 400, 'invalid-path'],
        [
          'POST',
          `${b}/sync`,
          sync({ edits: [{ ...edit, path: 'memos/a\u0000.md' }] }),
          400,
          'invalid-path',
        ],
        [
          'POST',
          `${b}/sync`,
          sync({ edits: [{ ...edit, path: 'memos/a\\b.md' }] }),
          400,
          'invalid-path',
        ],
        [
          'POST',
          `${b}/sync`,
          sync({ edits: [{ ...edit, path: 'memos/é.md' }] }),
          400,
          'invalid-path',
        ],
        [
          'POST',
          `${b}/sync`,
          sync({ edits: [{ ...edit, path: `memos/${'x'.repeat(256)}.md` }] }),
          400,
          'invalid-path',
        ],
        [
          'POST',
          `${b}/sync`,
          sync({ edits: [{ ...edit, path: `memos/${'abcdefgh/'.repeat(120)}x.md` }] }),
          400,
          'invalid-path',
        ],
        [
          'POST',
          `${b}/sync`,
          sync({ edits: [{ ...edit, path: 'memos//x.md' }] }),
          400,
          'invalid-path',
        ],
        [
          'POST',
          `${b}/sync`,
          sync({ edits: [{ ...edit, path: 'memos/./x.md' }] }),
          400,
          'invalid-path',
        ],
        [
          'POST',
          `${b}/sync`,
          sync({ edits: [{ ...edit, path: 'memos/.hidden.md' }] }),
          400,
          'invalid-path',
        ],
        [
          'POST',
          `${b}/sync`,
          sync({ edits: [{ ...edit, baseHash: undefined }] }),
          400,
          'invalid-request',
        ],
        [
          'POST',
          `${b}/sync`,
          sync({ edits: [{ ...edit, baseHash: 'A'.repeat(64) }] }),
          400,
          'invalid-request',
        ],
        [
          'POST',
          `${b}/sync`,
          sync({ edits: [{ ...edit, text: undefined }] }),
          400,
          'invalid-request',
        ],
        ['POST', `${b}/sync`, sync({ edits: [{ ...edit, text: 5 }] }), 400, 'invalid-request'],
        ['POST', `${b}/sync`, sync({ edits: [{ ...edit, text: big }] }), 413, 'too-large'],
        [
          'POST',
          `${b}/sync`,
          sync({ edits: [{ ...edit, to: 'memos/b.md' }] }),
          400,
          'invalid-request',
        ],
        [
          'POST',
          `${b}/sync`,
          sync({
            edits: [{ id: 'd', op: 'delete', path: 'memos/ok.md', baseHash: okHash, text: '' }],
          }),
          400,
          'invalid-request',
        ],
        [
          'POST',
          `${b}/sync`,
          sync({
            edits: [
              { id: 'd', op: 'delete', path: 'memos/ok.md', baseHash: okHash, to: 'memos/b.md' },
            ],
          }),
          400,
          'invalid-request',
        ],
        [
          'POST',
          `${b}/sync`,
          sync({ edits: [{ id: 'r', op: 'rename', path: 'memos/ok.md', baseHash: okHash }] }),
          400,
          'invalid-path',
        ],
        [
          'POST',
          `${b}/sync`,
          sync({
            edits: [
              { id: 'r', op: 'rename', path: 'memos/ok.md', to: 'memos/b.md', baseHash: null },
            ],
          }),
          400,
          'invalid-request',
        ],
        [
          'POST',
          `${b}/sync`,
          sync({
            edits: [
              {
                id: 'r',
                op: 'rename',
                path: 'memos/ok.md',
                to: 'memos/b.md',
                baseHash: okHash,
                text: '',
              },
            ],
          }),
          400,
          'invalid-request',
        ],
        [
          'POST',
          `${b}/sync`,
          sync({
            edits: [
              { id: 'r', op: 'rename', path: 'memos/ok.md', to: 'private/b.md', baseHash: okHash },
            ],
          }),
          403,
          'excluded',
        ],
        [
          'POST',
          `${b}/sync`,
          sync({
            edits: [
              { id: 'r', op: 'rename', path: 'memos/ok.md', to: 'memos/new.md', baseHash: okHash },
              edit,
            ],
          }),
          400,
          'invalid-request',
        ],
        ['POST', `${b}/sync`, sync({ events: [5] }), 400, 'invalid-request'],
        ['POST', `${b}/sync`, sync({ events: [{ ...event, extra: 1 }] }), 400, 'invalid-request'],
        [
          'POST',
          `${b}/sync`,
          sync({ events: [{ ...event, to: 'memos/b.md' }] }),
          400,
          'invalid-request',
        ],
        [
          'POST',
          `${b}/sync`,
          raw(`{"since":0,"events":[${JSON.stringify(event).slice(0, -1)},"__proto__":{}}]}`),
          400,
          'invalid-request',
        ],
        [
          'POST',
          `${b}/sync`,
          sync({ events: [{ ...event, kind: undefined }] }),
          400,
          'invalid-event',
        ],
        [
          'POST',
          `${b}/sync`,
          sync({ events: [{ ...event, kind: 'toString' }] }),
          400,
          'invalid-event',
        ],
        [
          'POST',
          `${b}/sync`,
          sync({ events: [{ ...event, kind: 'rename' }] }),
          400,
          'invalid-event',
        ],
        [
          'POST',
          `${b}/sync`,
          sync({ events: [{ ...event, kind: 'rename', to: 'memos/ok.md' }] }),
          400,
          'invalid-event',
        ],
        ['POST', `${b}/sync`, sync({ events: [{ ...event, id: '' }] }), 400, 'invalid-event'],
        [
          'POST',
          `${b}/sync`,
          sync({ events: [{ ...event, id: 'x'.repeat(201) }] }),
          400,
          'invalid-event',
        ],
        [
          'POST',
          `${b}/sync`,
          sync({ events: [{ ...event, id: undefined }] }),
          400,
          'invalid-event',
        ],
        ['POST', `${b}/sync`, sync({ events: [{ ...event, time: 1.5 }] }), 400, 'invalid-event'],
        [
          'POST',
          `${b}/sync`,
          sync({ events: [{ ...event, time: String(now) }] }),
          400,
          'invalid-event',
        ],
        ['POST', `${b}/sync`, sync({ events: [{ ...event, item: '' }] }), 400, 'invalid-event'],
        ['POST', `${b}/sync`, sync({ events: [{ ...event, client: 5 }] }), 400, 'invalid-event'],
        [
          'POST',
          `${b}/sync`,
          sync({ events: [{ ...event, time: now + 10_000 }] }),
          422,
          'future-event',
        ],
        [
          'POST',
          `${b}/sync`,
          sync({ events: [{ ...event, item: 'private/x.md' }] }),
          403,
          'excluded',
        ],
        [
          'POST',
          `${b}/sync`,
          sync({ events: [{ ...event, kind: 'rename', to: 'private/x.md' }] }),
          403,
          'excluded',
        ],
        ['POST', `${b}/sync`, sync({ changes: [5] }), 400, 'invalid-request'],
        ['POST', `${b}/sync`, sync({ changes: [{ ...change, extra: 1 }] }), 400, 'invalid-request'],
        [
          'POST',
          `${b}/sync`,
          sync({ changes: [{ ...change, message: 'x'.repeat(20_001) }] }),
          400,
          'invalid-request',
        ],
        ['POST', `${b}/sync`, sync({ changes: [{ ...change, message: 5 }] }), 400, 'invalid-event'],
        ['POST', `${b}/sync`, sync({ changes: [{ ...change, op: '' }] }), 400, 'invalid-event'],
        ['POST', `${b}/sync`, sync({ changes: [{ ...change, op: 5 }] }), 400, 'invalid-event'],
        [
          'POST',
          `${b}/sync`,
          sync({ changes: [{ ...change, paths: 'memos/ok.md' }] }),
          400,
          'invalid-event',
        ],
        ['POST', `${b}/sync`, sync({ changes: [{ ...change, paths: [5] }] }), 400, 'invalid-event'],
        [
          'POST',
          `${b}/sync`,
          sync({ changes: [{ ...change, paths: [''] }] }),
          400,
          'invalid-event',
        ],
        [
          'POST',
          `${b}/sync`,
          sync({ changes: [{ ...change, id: undefined }] }),
          400,
          'invalid-event',
        ],
        ['POST', `${b}/sync`, sync({ changes: [{ ...change, client: '' }] }), 400, 'invalid-event'],
        ['POST', `${b}/sync`, sync({ changes: [{ ...change, time: -0.5 }] }), 400, 'invalid-event'],
        [
          'POST',
          `${b}/sync`,
          sync({ changes: [{ ...change, time: now + 10_000 }] }),
          422,
          'future-event',
        ],
        [
          'POST',
          `${b}/sync`,
          sync({ changes: [{ ...change, paths: ['private/x.md'] }] }),
          403,
          'excluded',
        ],
        ['POST', `${b}/sync`, sync({ configRevision: 99 }), 409, 'config-changed'],

        // Notes: path parameters, query strings and bodies
        ['GET', `${b}/notes/memos%2F..%2Fx.md`, undefined, 400, 'invalid-path'],
        ['GET', `${b}/notes/memos/x.txt`, undefined, 400, 'invalid-path'],
        ['GET', `${b}/notes/memos/%ZZ.md`, undefined, 400, 'invalid-path'],
        ['GET', `${b}/notes/memos/a%00.md`, undefined, 400, 'invalid-path'],
        ['GET', `${b}/notes/.git/config.md`, undefined, 400, 'invalid-path'],
        ['GET', `${b}/notes/private/x.md?record=false`, undefined, 403, 'excluded'],
        ['GET', `${b}/notes/memos/ok.md?record=maybe`, undefined, 400, 'invalid-argument'],
        ['PUT', `${b}/notes/memos/ok.md`, 'x', 400, 'invalid-request'],
        ['PUT', `${b}/notes/memos/ok.md`, [], 400, 'invalid-request'],
        ['PUT', `${b}/notes/memos/ok.md`, {}, 400, 'invalid-argument'],
        ['PUT', `${b}/notes/memos/ok.md`, { text: 5 }, 400, 'invalid-argument'],
        ['PUT', `${b}/notes/memos/ok.md`, { text: 'x', baseHash: 'abc' }, 400, 'invalid-argument'],
        ['PUT', `${b}/notes/memos/ok.md`, { text: 'x', baseHash: 5 }, 400, 'invalid-argument'],
        ['PUT', `${b}/notes/memos/ok.md`, { text: 'x', message: 5 }, 400, 'invalid-argument'],
        [
          'PUT',
          `${b}/notes/memos/ok.md`,
          { text: 'x', message: 'x'.repeat(20_001) },
          400,
          'invalid-argument',
        ],
        ['PUT', `${b}/notes/memos/ok.md`, { text: big }, 413, 'too-large'],
        ['PUT', `${b}/notes/memos/ok.md`, { text: 'x', baseHash: hash }, 409, 'conflict'],
        ['PUT', `${b}/notes/private/x.md`, { text: 'x' }, 403, 'excluded'],
        ['PUT', `${b}/notes/sources/s.md`, 'x', 400, 'invalid-request'],
        ['DELETE', `${b}/notes/memos/gone.md`, undefined, 404, 'not-found'],
        ['GET', `${b}/notes/memos/ok.md/history?limit=0`, undefined, 400, 'invalid-argument'],
        ['GET', `${b}/notes/memos/ok.md/history?limit=1001`, undefined, 400, 'invalid-argument'],
        ['GET', `${b}/notes/memos/ok.md/history?limit=x`, undefined, 400, 'invalid-argument'],
        ['GET', `${b}/notes/memos/../history`, undefined, 400, 'invalid-path'],
        ['GET', `${b}/notes/memos/ok.md/versions?hash=abc`, undefined, 400, 'invalid-argument'],
        ['GET', `${b}/notes/memos/ok.md/versions`, undefined, 400, 'invalid-argument'],
        ['GET', `${b}/notes/memos/ok.md/versions?hash=${hash}`, undefined, 404, 'not-found'],
        ['GET', `${b}/notes/memos/ok.md/versions/zz`, undefined, 400, 'invalid-argument'],
        ['GET', `${b}/notes/memos/ok.md/versions/${'0'.repeat(40)}`, undefined, 404, 'not-found'],
        ['GET', `${b}/notes/private/x.md/history`, undefined, 403, 'excluded'],
        ['POST', `${b}/notes/memos/ok.md/restore`, 'x', 400, 'invalid-request'],
        ['POST', `${b}/notes/memos/ok.md/restore`, {}, 400, 'invalid-argument'],
        ['POST', `${b}/notes/memos/ok.md/restore`, { commit: 5 }, 400, 'invalid-argument'],
        ['POST', `${b}/notes/memos/ok.md/restore`, { commit: 'zz' }, 400, 'invalid-argument'],
        [
          'POST',
          `${b}/notes/memos/ok.md/restore`,
          { commit: '0'.repeat(40), baseHash: 'x' },
          400,
          'invalid-argument',
        ],
        [
          'POST',
          `${b}/notes/memos/ok.md/restore`,
          { commit: '0'.repeat(40), message: 5 },
          400,
          'invalid-argument',
        ],
        ['POST', `${b}/notes/memos/ok.md/restore`, { commit: '0'.repeat(40) }, 404, 'not-found'],

        // Rename, search, list, log, diary
        ['POST', `${b}/rename`, 'x', 400, 'invalid-request'],
        ['POST', `${b}/rename`, {}, 400, 'invalid-path'],
        ['POST', `${b}/rename`, { from: '../x.md', to: 'memos/b.md' }, 400, 'invalid-path'],
        ['POST', `${b}/rename`, { from: 'memos/ok.md' }, 400, 'invalid-path'],
        ['POST', `${b}/rename`, { from: 'memos/ok.md', to: 5 }, 400, 'invalid-path'],
        [
          'POST',
          `${b}/rename`,
          { from: 'memos/ok.md', to: 'memos/b.md', message: 5 },
          400,
          'invalid-argument',
        ],
        ['POST', `${b}/rename`, { from: 'memos/ok.md', to: 'private/b.md' }, 403, 'excluded'],
        ['POST', `${b}/rename`, { from: 'memos/gone.md', to: 'memos/b.md' }, 404, 'not-found'],
        ['GET', `${b}/search?q=x&mode=frob`, undefined, 400, 'invalid-argument'],
        ['GET', `${b}/search?q=x&limit=abc`, undefined, 400, 'invalid-argument'],
        ['GET', `${b}/search?q=x&limit=1.5`, undefined, 400, 'invalid-argument'],
        ['GET', `${b}/search?q=x&limit=${2 ** 53}`, undefined, 400, 'invalid-argument'],
        ['GET', `${b}/list?mode=frob`, undefined, 400, 'invalid-argument'],
        ['GET', `${b}/list?limit=x`, undefined, 400, 'invalid-argument'],
        ['GET', `${b}/log?path=..%2Fx.md`, undefined, 400, 'invalid-path'],
        ['GET', `${b}/log?since=x`, undefined, 400, 'invalid-argument'],
        ['GET', `${b}/log?until=1.5`, undefined, 400, 'invalid-argument'],
        ['GET', `${b}/log?limit=x`, undefined, 400, 'invalid-argument'],
        ['GET', `${b}/log?all=maybe`, undefined, 400, 'invalid-argument'],
        ['POST', `${b}/diary`, 'x', 400, 'invalid-request'],
        ['POST', `${b}/diary`, [], 400, 'invalid-request'],
        ['POST', `${b}/diary`, { date: 5 }, 400, 'invalid-argument'],
        ['POST', `${b}/diary`, { date: 'x'.repeat(20_001) }, 400, 'invalid-argument'],
        ['POST', `${b}/diary`, { date: 'someday' }, 400, 'invalid-argument'],
        ['GET', `${b}/diary?date=someday`, undefined, 400, 'invalid-argument'],
        ['GET', `${b}/diary?date=`, undefined, 400, 'invalid-argument'],
        ['GET', `${b}/search?q=x&since=`, undefined, 400, 'invalid-argument'],
        ['GET', `${b}/frobnicate`, undefined, 404, 'not-found'],
        ['GET', `${b}/status/x`, undefined, 404, 'not-found'],
        ['PATCH', `${b}/notes/memos/ok.md`, undefined, 405, 'method-not-allowed'],
      ];
      const send = async (method: string, path: string, body: unknown) => {
        if (body !== null && typeof body === 'object' && 'raw' in body) {
          const r = await server.app.handle(
            new Request(`http://somememos.test${path}`, {
              method,
              headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
              body: (body as { raw: string }).raw,
            }),
          );
          return { status: r.status, body: await r.json() };
        }
        return server.request(method, path, body);
      };
      const failures: string[] = [];
      for (const [method, path, body, status, code] of cases) {
        const r = await send(method, path, body);
        const got = [r.status, r.body?.error?.code ?? r.body?.status];
        if (got[0] !== status || got[1] !== code) {
          failures.push(
            `${method} ${path} ${JSON.stringify(body)?.slice(0, 100)}: got ${got.join(' ')}, want ${status} ${code}`,
          );
        }
        // Never an excluded path (the config a 409 carries names the folder only).
        const text = JSON.stringify(r.body);
        expect(text, `${method} ${path}`).not.toMatch(/private\/[a-z]/);
        expect(text, `${method} ${path}`).not.toContain(TOKEN);
      }
      expect(failures).toEqual([]);

      for (const [text, type, status, code] of [
        ['{"since":0,', 'application/json', 400, 'invalid-json'],
        ['', 'application/json', 400, 'invalid-json'],
        ['{"since":0}', 'text/plain', 415, 'unsupported-media-type'],
      ] as const) {
        const r = await server.app.handle(
          new Request(`http://somememos.test${b}/sync`, {
            method: 'POST',
            headers: { authorization: `Bearer ${TOKEN}`, 'content-type': type },
            body: text,
          }),
        );
        const body = (await r.json()) as { error: { code: string } };
        expect([r.status, body.error.code]).toEqual([status, code]);
      }

      expect((await server.request('GET', b)).body.mutation).toBe(before);
      expect((await runGit(dir, ['rev-list', '--count', 'HEAD'])).trim()).toBe(commits);
      expect(
        (await server.request('GET', '/api/brains')).body.brains.map((x: { id: string }) => x.id),
      ).toEqual(['pins']);
      expect((await server.request('GET', `${b}/blog`)).body.enabled).toBe(false);
      expect((await server.request('GET', `${b}/config`)).body.revision).toBe(1);
      expect(
        (await server.request('GET', `${b}/titles`)).body.notes.map(
          (n: { path: string }) => n.path,
        ),
      ).toEqual(['memos/ok.md']);

      // Accepted inputs at the edges (these may change the brain).
      const accepted: [string, string, unknown, number][] = [
        ['GET', `${b}/search?q=&limit=&mode=`, undefined, 200],
        ['GET', `${b}/search?q=x&limit=5&mode=trending&unknown=1`, undefined, 200],
        ['GET', `${b}/list?mode=all&limit=1`, undefined, 200],
        [
          'GET',
          `${b}/log?path=memos%2Fok.md&since=0&until=${now}&limit=5&all=1&op=update&q=x`,
          undefined,
          200,
        ],
        ['GET', `${b}/log?all=false&since=-5`, undefined, 200],
        ['GET', `${b}/notes/memos/ok.md?record=0`, undefined, 200],
        ['GET', `${b}/notes/memos/ok.md?record=`, undefined, 200],
        ['GET', `${b}/notes/memos/ok.md/history?limit=1000`, undefined, 200],
        ['GET', `${b}/notes/memos/ok.md/history?limit=`, undefined, 200],
        ['GET', `${b}/notes/memos/ok.md/versions?hash=${okHash}`, undefined, 200],
        ['GET', `${b}/blog/slug?slug=A`, undefined, 200],
        ['GET', `${b}/blog/slug`, undefined, 200],
        ['GET', `${b}/blog/address?path=memos%2Fok.md`, undefined, 200],
        ['GET', `${b}/diary?date=2026-11-27`, undefined, 200],
        ['PUT', `${b}/blog`, { enabled: false }, 200],
        [
          'PUT',
          `${b}/blog`,
          { enabled: false, slug: '', title: '  ', language: '', author: null },
          200,
        ],
        [
          'PUT',
          `${b}/blog`,
          { enabled: true, slug: 'my-blog', title: ' T ', language: 'pt-BR' },
          200,
        ],
        ['POST', `${b}/sync`, { since: 0 }, 200],
        ['POST', `${b}/sync`, { since: -0, client: 'a.b:c-d_E9', configRevision: 1 }, 200],
        ['POST', `${b}/sync`, sync({ events: [], changes: [], edits: [] }), 200],
        ['POST', `${b}/sync`, sync({ changes: [{ id: 'c2', time: now, client: 'c' }] }), 200],
        [
          'POST',
          `${b}/sync`,
          sync({ changes: [{ ...change, id: 'c3', message: 'x'.repeat(20_000) }] }),
          200,
        ],
        ['POST', `${b}/sync`, sync({ events: [{ ...event, id: 'v2', time: now + 300 }] }), 200],
        ['POST', `${b}/sync`, sync({ events: [{ ...event, id: 'x'.repeat(200), time: -1 }] }), 200],
        ['POST', `${b}/sync`, sync({ edits: [{ ...edit, path: 'memos/café.md', text: '' }] }), 200],
        [
          'PUT',
          `${b}/notes/memos/edge.md`,
          { text: 'x'.repeat(2 * 1024 * 1024), message: null },
          200,
        ],
        ['PUT', `${b}/notes/memos/edge.md`, { text: 'y', baseHash: null }, 409],
        [
          'POST',
          `${b}/changes`,
          { message: null, ops: [{ ...write, path: 'memos/batch.md' }] },
          200,
        ],
        ['POST', `${b}/diary`, {}, 200],
        ['POST', `${b}/diary`, { date: null }, 200],
        ['PUT', `${b}/config`, { baseRevision: 0, config: {} }, 409],
        ['POST', '/api/brains', { id: 'a'.repeat(63) }, 201],
        ['POST', '/api/brains', { id: 'with-config', config: null }, 201],
      ];
      const wrong: string[] = [];
      for (const [method, path, body, status] of accepted) {
        const r = await send(method, path, body);
        if (r.status !== status) {
          wrong.push(`${method} ${path}: got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
        }
      }
      expect(wrong).toEqual([]);
    },
  );

  it(
    'refuses what it used to accept before its inputs had schemas',
    { timeout: 60_000 },
    async () => {
      // Each of these was accepted (or failed with a 500) before the request schemas.
      const server = await testServer();
      await createBrain(server, 'tight');
      const a = testClient(server, 'tight', 'phone');
      await a.engine.index();
      await a.engine.saveNote('memos/ok.md', '# Ok\n');
      await a.sync();
      const b = '/api/brains/tight';
      const dir = join(server.dataDir, 'brains', 'tight');
      const before = (await server.request('GET', b)).body.mutation;
      const commits = (await runGit(dir, ['rev-list', '--count', 'HEAD'])).trim();
      const okHash = (await server.request('GET', `${b}/notes/memos/ok.md?record=false`)).body.hash;
      const lone = 'memos/\ud800.md';
      const cases: [string, string, unknown, number, string][] = [
        [
          'PUT',
          `${b}/notes/memos/ok.md`,
          { text: 'x', baseHash: okHash, extra: 1 },
          400,
          'invalid-request',
        ],
        [
          'POST',
          `${b}/rename`,
          { from: 'memos/ok.md', to: 'memos/b.md', extra: 1 },
          400,
          'invalid-request',
        ],
        [
          'POST',
          `${b}/notes/memos/ok.md/restore`,
          { commit: '0'.repeat(40), extra: 1 },
          400,
          'invalid-request',
        ],
        ['POST', `${b}/diary`, { extra: 1 }, 400, 'invalid-request'],
        [
          'DELETE',
          `${b}/notes/memos/ok.md?message=${'x'.repeat(20_001)}`,
          undefined,
          400,
          'invalid-argument',
        ],
        ['GET', `${b}/search?q=x&limit=0x10`, undefined, 400, 'invalid-argument'],
        ['GET', `${b}/list?limit=1e3`, undefined, 400, 'invalid-argument'],
        ['GET', `${b}/log?since=%205`, undefined, 400, 'invalid-argument'],
        ['GET', `${b}/notes/memos/ok.md/history?limit=0b11`, undefined, 400, 'invalid-argument'],
        ['POST', `${b}/rename`, { from: 'memos/ok.md', to: lone }, 400, 'invalid-path'],
        [
          'POST',
          `${b}/sync`,
          { since: 0, edits: [{ id: 'e', op: 'write', path: lone, baseHash: null, text: '' }] },
          400,
          'invalid-path',
        ],
        [
          'POST',
          `${b}/changes`,
          { ops: [{ op: 'write', path: lone, baseHash: null, text: '' }] },
          400,
          'invalid-path',
        ],
        [
          'POST',
          `${b}/sync`,
          {
            since: 0,
            events: [{ id: 'v', kind: 'read', item: 'memos/ok.md', time: 2 ** 53, client: 'c' }],
          },
          400,
          'invalid-event',
        ],
      ];
      const failures: string[] = [];
      for (const [method, path, body, status, code] of cases) {
        const r = await server.request(method, path, body);
        if (r.status !== status || r.body?.error?.code !== code) {
          failures.push(`${method} ${path.slice(0, 80)}: got ${r.status} ${r.body?.error?.code}`);
        }
      }
      expect(failures).toEqual([]);
      const notUtf8 = await server.app.handle(
        new Request(`http://somememos.test${b}/sync`, {
          method: 'POST',
          headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
          body: new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x30, 0x7d]),
        }),
      );
      const refused = (await notUtf8.json()) as { error: { code: string } };
      expect([notUtf8.status, refused.error.code]).toEqual([400, 'invalid-json']);
      expect((await server.request('GET', b)).body.mutation).toBe(before);
      expect((await runGit(dir, ['rev-list', '--count', 'HEAD'])).trim()).toBe(commits);
    },
  );

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
      renamedFrom: string | null;
    }[];
    // The rename is one version, at the new path, naming the old one.
    expect(versions.map((v) => [v.path, v.message, v.client, v.renamedFrom])).toEqual([
      ['memos/kilns/electric.md', 'update move', 'agent-7', 'memos/kiln.md'],
      ['memos/kiln.md', 'update firing', 'agent-7', null],
      ['memos/kiln.md', 'ingest kiln', 'agent-7', null],
    ]);
    expect(new Set(versions.map((v) => v.commit)).size).toBe(versions.length);
    // The old path's own history still shows the move away, once.
    const old = await server.request('GET', `${b}/notes/memos/kiln.md/history`);
    expect(
      (old.body.versions as { message: string; renamedTo: string | null }[]).map((v) => [
        v.message,
        v.renamedTo,
      ]),
    ).toEqual([
      ['update move', 'memos/kilns/electric.md'],
      ['update firing', null],
      ['ingest kiln', null],
    ]);
    const first = versions[2] as (typeof versions)[number];
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
  it('serves pure reads without the brain lock, from the recorded commit', async () => {
    const server = await testServer();
    await createBrain(server, 'reads');
    const b = '/api/brains/reads';
    // Before the first commit a read falls back to the locked path, and still works.
    expect((await server.request('GET', `${b}/list`)).status).toBe(200);
    await server.request('PUT', `${b}/notes/memos/kiln.md`, {
      text: '# Kiln\n\nGlaze firing [[Cone Six]].\n',
      message: 'ingest kiln notes',
    });
    // Another process holds the brain's lock (as a long write would).
    const holder = await server.pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      'somememos-brain:reads',
    ]);
    // A stray edit in the working tree that no request committed: reads never see it.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(server.dataDir, 'brains', 'reads', 'memos', 'kiln.md'), '# Torn\n');
    try {
      const reads = await Promise.all([
        server.request('GET', `${b}/search?q=glaze`),
        server.request('GET', `${b}/list`),
        server.request('GET', `${b}/status`),
        server.request('GET', `${b}/titles`),
        server.request('GET', `${b}/dangling`),
        server.request('GET', `${b}/log?q=kiln`),
        server.request('GET', `${b}/notes/memos/kiln.md/history`),
        server.request('GET', `${b}/notes/memos/kiln.md?record=false`),
      ]);
      expect(reads.map((r) => r.status)).toEqual(Array(8).fill(200));
      expect(reads[0]?.body.results.map((r: { item: string }) => r.item)).toEqual([
        'memos/kiln.md',
      ]);
      expect(reads[4]?.body.dangling).toEqual([{ key: 'cone six', display: 'Cone Six', count: 1 }]);
      expect(reads[5]?.body.changes.map((c: { message: string }) => c.message)).toEqual([
        'ingest kiln notes',
      ]);
      expect(reads[7]?.body).toMatchObject({ text: '# Kiln\n\nGlaze firing [[Cone Six]].\n' });
      // A read that logs an event waits for the lock.
      let done = false;
      const recorded = server.request('GET', `${b}/notes/memos/kiln.md`).then((r) => {
        done = true;
        return r;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(done).toBe(false);
      await holder.query('ROLLBACK');
      // The locked request first puts the working tree back to the recorded commit.
      expect((await recorded).body).toMatchObject({
        recorded: true,
        text: '# Kiln\n\nGlaze firing [[Cone Six]].\n',
      });
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });
});
