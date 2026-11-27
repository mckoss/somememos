// Test helpers (test-only, excluded from the build): a Postgres schema per
// test file, temporary data directories, an app with a fixed token and a
// settable clock, and simulated offline clients built from core's engine on
// in-memory stores that sync with the app through its real HTTP handler.
//
// The Postgres tests run only when SOMEMEMOS_TEST_DATABASE_URL is set (start
// one with packages/pg-store/scripts/dev-postgres.sh); otherwise each file
// registers one skipped test saying why. All content is invented.

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { engine as coreEngine, storage, sync as coreSync, type sync } from '@somememos/core';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { FailureLimiter, parseTokens } from './auth.js';
import type { ServerConfig } from './config.js';
import { createApp, type App } from './http.js';

export const TEST_DATABASE_URL = process.env.SOMEMEMOS_TEST_DATABASE_URL || undefined;

export const SKIP_MESSAGE =
  'Postgres tests skipped: SOMEMEMOS_TEST_DATABASE_URL is not set ' +
  '(start one with packages/pg-store/scripts/dev-postgres.sh)';

/** Registers `fn`'s tests when the test database is configured, else one skipped test saying why. */
export function describePg(name: string, fn: () => void): void {
  if (TEST_DATABASE_URL) describe(name, fn);
  else describe(name, () => it.skip(SKIP_MESSAGE, () => {}));
}

const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/** A temporary directory, removed after the test file. */
export function tempDir(prefix = 'somememos-server-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A pool on the test database in a fresh schema, dropped after the test file. */
export async function testPool(): Promise<pg.Pool> {
  if (!TEST_DATABASE_URL) throw new Error(SKIP_MESSAGE);
  const schema = `somememos_server_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const pool = new pg.Pool({
    connectionString: TEST_DATABASE_URL,
    max: 8,
    options: `-c search_path=${schema}`,
  });
  cleanups.push(async () => {
    await pool.end();
    const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await c.connect();
    await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await c.end();
  });
  return pool;
}

export const TOKEN = 'test-token-0123456789abcdefghijkl';
export const T0 = 1_800_000_000;

/** A settable clock in whole Unix seconds. */
export interface Clock {
  (): number;
  set(t: number): void;
  tick(seconds?: number): number;
}

export function clock(start = T0): Clock {
  let now = start;
  const fn = (() => now) as Clock;
  fn.set = (t) => {
    now = t;
  };
  fn.tick = (s = 60) => (now += s);
  return fn;
}

export interface TestServer {
  readonly app: App;
  readonly pool: pg.Pool;
  readonly dataDir: string;
  readonly now: Clock;
  /** A JSON request through the app's handler, with the test token unless `token` is given (null: none). */
  request(
    method: string,
    path: string,
    body?: unknown,
    options?: { token?: string | null; headers?: Record<string, string> },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON of any route, checked by each test
  ): Promise<{ status: number; body: any; headers: Headers }>;
}

export function serverConfig(dataDir: string, extra: Partial<ServerConfig> = {}): ServerConfig {
  return {
    databaseUrl: TEST_DATABASE_URL ?? null,
    dataDir,
    tokens: parseTokens(TOKEN).tokens,
    port: null,
    pageSize: 2000,
    ...extra,
  };
}

/** An app on a fresh schema and data directory. */
export async function testServer(
  options: {
    now?: Clock;
    pageSize?: number;
    beforeDatabaseCommit?: (brainId: string) => void | Promise<void>;
  } = {},
): Promise<TestServer> {
  const pool = await testPool();
  const dataDir = tempDir();
  const now = options.now ?? clock();
  const app = createApp({
    config: serverConfig(dataDir, options.pageSize ? { pageSize: options.pageSize } : {}),
    pool,
    now,
    limiter: new FailureLimiter({ perAddress: 10_000, total: 100_000 }),
    ...(options.beforeDatabaseCommit ? { beforeDatabaseCommit: options.beforeDatabaseCommit } : {}),
    log: { error: () => undefined, info: () => undefined, warn: () => undefined },
  });
  await app.start();
  return {
    app,
    pool,
    dataDir,
    now,
    async request(method, path, body, opts = {}) {
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      const token = opts.token === undefined ? TOKEN : opts.token;
      if (token !== null) headers.authorization = `Bearer ${token}`;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await app.handle(
        new Request(`http://somememos.test${path}`, {
          method,
          headers,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }),
        { clientAddress: '127.0.0.1' },
      );
      const text = await response.text();
      return {
        status: response.status,
        body: text ? JSON.parse(text) : null,
        headers: response.headers,
      };
    },
  };
}

/** The default folder layout plus an excluded folder, as test brains use. */
export const TEST_ROLES = {
  memo: ['memos/'],
  dated: ['diary/{YYYY}/{MM}/{YYYY}-{MM}-{DD}.md'],
  source: ['sources/'],
  excluded: ['private/'],
};

/** An offline copy: core's engine on in-memory stores, syncing through the app. */
export interface TestClient {
  readonly id: string;
  readonly engine: coreEngine.Engine;
  readonly stores: storage.MemoryStores;
  readonly content: storage.MemoryContentStore;
  /** Syncs until nothing is left (runSync over the app's sync route). */
  sync(options?: coreEngine.PrepareSyncOptions): Promise<coreEngine.RunSyncResult>;
  /** Sends one request (for tests that look at the raw exchange). */
  send(request: sync.SyncRequest): Promise<sync.SyncResponse>;
}

export function testClient(
  server: TestServer,
  brainId: string,
  id: string,
  now: Clock = server.now,
): TestClient {
  const stores = storage.createMemoryStores({ now });
  const content = storage.createMemoryContentStore({ now });
  const config = storage.parseBrainConfig({ clientId: id, roles: TEST_ROLES });
  const engine = coreEngine.createEngine({ stores, content, config, now });
  const send = async (request: sync.SyncRequest): Promise<sync.SyncResponse> => {
    const r = await server.request('POST', `/api/brains/${brainId}/sync`, request);
    if (r.status !== 200) throw new Error(`sync failed: ${r.status} ${JSON.stringify(r.body)}`);
    // Every response the tests see has exactly the shape core's schema
    // describes: it passes, and the schema drops nothing from it (no field
    // the schema does not know), so the server and the clients cannot drift.
    const checked = coreSync.parseWith(coreSync.SyncResponseSchema, r.body);
    if (!checked.ok) throw new Error(`bad sync response: ${coreSync.issueMessage(checked.issue)}`);
    expect(checked.value).toStrictEqual(r.body);
    return r.body as sync.SyncResponse;
  };
  return {
    id,
    engine,
    stores,
    content,
    send,
    sync: (options = {}) => coreEngine.runSync(engine, send, options),
  };
}

/** Creates a brain with the test roles. */
export async function createBrain(server: TestServer, id: string): Promise<void> {
  const r = await server.request('POST', '/api/brains', { id, config: { roles: TEST_ROLES } });
  if (r.status !== 201) throw new Error(`create failed: ${r.status} ${JSON.stringify(r.body)}`);
}
