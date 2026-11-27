// Test-only: a real somememos server for the CLI's remote-mode tests. The
// server's handler (`@somememos/server`'s `createApp`, the same one apps/web
// mounts) on a small Node HTTP server on 127.0.0.1, with a Postgres schema of
// its own on SOMEMEMOS_TEST_DATABASE_URL and a temporary data directory.
//
// The tests run only when SOMEMEMOS_TEST_DATABASE_URL is set (start one with
// packages/pg-store/scripts/dev-postgres.sh); otherwise each file registers
// one skipped test saying why. All content is invented.

import { randomUUID } from 'node:crypto';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FailureLimiter, createApp, parseTokens, type App } from '@somememos/server';
import pg from 'pg';
import { describe, it } from 'vitest';
import { tempDir } from '../brain/testing.js';

export const TEST_DATABASE_URL = process.env.SOMEMEMOS_TEST_DATABASE_URL || undefined;

export const SKIP_MESSAGE =
  'remote-mode tests skipped: SOMEMEMOS_TEST_DATABASE_URL is not set ' +
  '(start one with: eval "$(packages/pg-store/scripts/dev-postgres.sh)")';

/** Registers `fn`'s tests when the test database is configured, else one skipped test saying why. */
export function describePg(name: string, fn: () => void, options: { timeout?: number } = {}): void {
  if (TEST_DATABASE_URL) describe(name, options, fn);
  else describe(name, () => it.skip(SKIP_MESSAGE, () => {}));
}

/** The test server's token: long and distinctive, so the tests can search every output for it. */
export const TEST_TOKEN = 'tok-SECRET-9f1c2e7a5b3d4c6e8a0b1c2d3e4f5a6b';

export interface TestServer {
  /** `http://127.0.0.1:<port>`. */
  readonly url: string;
  readonly port: number;
  readonly app: App;
  /** The server's clock (Unix seconds); set it to match the CLI's. */
  now: number;
  /** A JSON request with the test token. */
  request(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }>;
  /** Creates a brain with the given roles. */
  createBrain(id: string, roles: object): Promise<void>;
  /** Stops listening (the port then refuses connections); `start` listens again on the same port. */
  stop(): Promise<void>;
  start(): Promise<void>;
  /** Stops for good and drops the schema. */
  close(): Promise<void>;
}

async function toRequest(req: import('node:http').IncomingMessage, base: string): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(key, v);
  }
  const method = req.method ?? 'GET';
  const body =
    chunks.length > 0 && method !== 'GET' && method !== 'HEAD' ? Buffer.concat(chunks) : undefined;
  return new Request(new URL(req.url ?? '/', base), {
    method,
    headers,
    ...(body ? { body } : {}),
  });
}

/** Starts a server on a fresh schema. */
export async function startTestServer(options: { now: number }): Promise<TestServer> {
  if (!TEST_DATABASE_URL) throw new Error(SKIP_MESSAGE);
  const schema = `somememos_cli_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const pool = new pg.Pool({
    connectionString: TEST_DATABASE_URL,
    max: 8,
    options: `-c search_path=${schema}`,
  });
  const data = tempDir('somememos-cli-server-');
  const state = { now: options.now };
  const app = createApp({
    config: {
      databaseUrl: TEST_DATABASE_URL,
      dataDir: data.dir,
      tokens: parseTokens(TEST_TOKEN).tokens,
      port: null,
      pageSize: 2000,
    },
    pool,
    now: () => state.now,
    limiter: new FailureLimiter({ perAddress: 10_000, total: 100_000 }),
    log: { error: () => undefined, info: () => undefined, warn: () => undefined },
  });
  await app.start();

  let server: Server | null = null;
  let port = 0;
  const listen = () =>
    new Promise<void>((resolve, reject) => {
      const s = createServer((req, res) => {
        void (async () => {
          try {
            const response = await app.handle(await toRequest(req, `http://127.0.0.1:${port}`), {
              clientAddress: '127.0.0.1',
            });
            const headers: Record<string, string> = {};
            response.headers.forEach((v, k) => (headers[k] = v));
            res.writeHead(response.status, headers);
            res.end(Buffer.from(await response.arrayBuffer()));
          } catch (error) {
            res.writeHead(500, { 'content-type': 'text/plain' });
            res.end(String(error));
          }
        })();
      });
      s.on('error', reject);
      s.listen(port, '127.0.0.1', () => {
        port = (s.address() as AddressInfo).port;
        server = s;
        resolve();
      });
    });
  await listen();

  const stop = () =>
    new Promise<void>((resolve) => {
      const s = server;
      server = null;
      if (!s) return resolve();
      s.closeAllConnections();
      s.close(() => resolve());
    });

  const result: TestServer = {
    get url() {
      return `http://127.0.0.1:${port}`;
    },
    get port() {
      return port;
    },
    app,
    get now() {
      return state.now;
    },
    set now(t: number) {
      state.now = t;
    },
    async request(method, path, body) {
      const response = await app.handle(
        new Request(`http://127.0.0.1:${port}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${TEST_TOKEN}`,
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }),
        { clientAddress: '127.0.0.1' },
      );
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },
    async createBrain(id, roles) {
      const r = await result.request('POST', '/api/brains', { id, config: { roles } });
      if (r.status !== 201) throw new Error(`create failed: ${r.status} ${JSON.stringify(r.body)}`);
    },
    stop,
    start: listen,
    async close() {
      await stop();
      await app.close();
      await pool.end();
      const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await c.connect();
      await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await c.end();
      data.remove();
    },
  };
  return result;
}
