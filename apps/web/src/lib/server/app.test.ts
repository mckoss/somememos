// The /api route through SvelteKit's real endpoint module, without a
// database: health answers with the version, every other route 503 (the web
// app works without a server). The API itself is tested in packages/server.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as endpoint from '../../routes/api/[...path]/+server.ts';
import { resetServerApp } from './app.ts';

type Handler = (event: unknown) => Promise<Response>;

function event(method: string, path: string, headers: Record<string, string> = {}) {
  return {
    request: new Request(`http://localhost${path}`, { method, headers }),
    getClientAddress: () => '127.0.0.1',
  };
}

const saved = { ...process.env };

describe('the /api endpoint', () => {
  beforeEach(async () => {
    delete process.env.DATABASE_URL;
    delete process.env.SOMEMEMOS_TOKEN;
    delete process.env.SOMEMEMOS_DATA_DIR;
    await resetServerApp();
  });
  afterEach(async () => {
    process.env = { ...saved };
    await resetServerApp();
  });

  it('answers health with the root package version, and the API with 503, without a database', async () => {
    const health = await (endpoint.GET as Handler)(event('GET', '/api/health'));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      version: __APP_VERSION__,
      status: 'ok',
      database: { configured: false },
    });
    for (const [method, path] of [
      ['GET', '/api/brains'],
      ['POST', '/api/brains/x/sync'],
      ['GET', '/api/brains/x/notes/memos/a.md'],
    ] as const) {
      const r = await (endpoint[method] as Handler)(event(method, path));
      expect(r.status).toBe(503);
      expect((await r.json()).error.code).toBe('no-database');
    }
  });

  it('reports an invalid configuration with 503 and names the problem', async () => {
    process.env.DATABASE_URL = 'postgres://127.0.0.1:1/none';
    await resetServerApp();
    const health = await (endpoint.GET as Handler)(event('GET', '/api/health'));
    expect(health.status).toBe(503);
    const body = await health.json();
    expect(body.status).toBe('misconfigured');
    expect(body.problems.join(' ')).toMatch(/SOMEMEMOS_TOKEN/);
    const api = await (endpoint.GET as Handler)(
      event('GET', '/api/brains', { authorization: 'Bearer whatever-token-0123456789' }),
    );
    expect(api.status).toBe(503);
  });

  it('refuses cross-origin requests', async () => {
    const r = await (endpoint.GET as Handler)(
      event('GET', '/api/health', { origin: 'https://elsewhere.example' }),
    );
    expect(r.status).toBe(403);
  });
});
