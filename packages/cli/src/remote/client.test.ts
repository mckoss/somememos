// The remote client without a server: requests it builds, errors it maps,
// when it retries, and that no message carries the token. Plus the
// working-folder config files. All values are invented.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { engine } from '@somememos/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../brain/testing.js';
import { RemoteError, createRemoteClient, encodeNotePath } from './client.js';
import {
  checkServerTransport,
  checkTokenFile,
  derivedClientId,
  insecureAllowed,
  normalizeServerUrl,
  parseWorkFolderConfig,
  resolveToken,
  sidecarKind,
  writeWorkFolderConfig,
} from './config.js';
import { createRemoteEngine } from './engine.js';

const TOKEN = 'tok-unit-7c1d9e3f5a2b4c6d8e0f1a2b3c4d';

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fn, calls };
}

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function client(responses: (Response | Error)[]) {
  const f = fakeFetch(responses);
  const c = createRemoteClient({
    server: 'https://brain.example.test/base',
    brainId: 'garden',
    token: TOKEN,
    clientId: 'agent-1',
    fetch: f.fn,
  });
  return { c, calls: f.calls };
}

function networkError(code: string): Error {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('x'), { code }),
  });
}

describe('the remote client', () => {
  it('declares a JSON content type on every request, with or without a body', async () => {
    // SvelteKit refuses a body-less DELETE (or POST, PUT) with no content type
    // as a cross-site form submission (403); the API behind it never sees it.
    const { c, calls } = client(
      ['GET', 'DELETE', 'POST', 'PUT'].map(() => jsonResponse(200, { ok: true })),
    );
    await c.brain('GET', 'status');
    await c.brain('DELETE', 'notes/memos/a.md');
    await c.brain('POST', 'diary');
    await c.brain('PUT', 'config', { body: {} });
    for (const call of calls) {
      expect((call.init.headers as Record<string, string>)['content-type']).toBe(
        'application/json',
      );
    }
  });

  it('sends the token, the client id and JSON, and encodes note paths', async () => {
    const { c, calls } = client([jsonResponse(200, { status: 'saved' })]);
    const remote = createRemoteEngine(c);
    await remote.saveNote('memos/a b#c.md', 'text', { baseHash: null, message: 'update x' });
    const call = calls[0] as Call;
    expect(call.url).toBe(
      'https://brain.example.test/base/api/brains/garden/notes/memos/a%20b%23c.md',
    );
    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers['x-somememos-client']).toBe('agent-1');
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse(call.init.body as string)).toEqual({
      text: 'text',
      baseHash: null,
      message: 'update x',
    });
    expect(encodeNotePath('a/b c.md')).toBe('a/b%20c.md');
  });

  it('returns a 409 conflict as a result, and turns engine errors back into EngineErrors', async () => {
    const { c } = client([
      jsonResponse(409, { status: 'conflict', path: 'memos/a.md', currentHash: 'h' }),
      jsonResponse(403, {
        error: { code: 'excluded', message: 'that path is excluded from somememos' },
      }),
    ]);
    const remote = createRemoteEngine(c);
    expect((await remote.saveNote('memos/a.md', 't', { baseHash: null })).status).toBe('conflict');
    const error = await remote.readNote('private/a.md').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(engine.EngineError);
    expect(error).toMatchObject({ code: 'excluded' });
  });

  it('maps 401, 503 and unknown answers to one-line messages without the token', async () => {
    const { c } = client([
      jsonResponse(401, {
        error: { code: 'unauthorized', message: 'a valid bearer token is required' },
      }),
      jsonResponse(503, { error: { code: 'no-database', message: 'this server has no database' } }),
      new Response('<html>not here</html>', { status: 404 }),
      jsonResponse(404, { error: { code: 'brain-not-found', message: 'no such brain' } }),
    ]);
    const messages: string[] = [];
    for (let i = 0; i < 4; i++) {
      const e = (await c.brain('GET', 'status').catch((x: unknown) => x)) as Error;
      expect(e).toBeInstanceOf(RemoteError);
      messages.push(e.message);
    }
    expect(messages).toEqual([
      'the server refused the token (check SOMEMEMOS_TOKEN or the token file)',
      'the server at brain.example.test is unavailable: this server has no database',
      'brain.example.test has no somememos API at that address (HTTP 404); check the server URL',
      'the server has no brain by that id',
    ]);
    for (const m of messages) expect(m).not.toContain(TOKEN);
  });

  it('retries an idempotent request once after a network failure, never a POST', async () => {
    const get = client([networkError('ECONNRESET'), jsonResponse(200, { ok: 1 })]);
    expect(await get.c.brain('GET', 'status')).toEqual({ ok: 1 });
    expect(get.calls).toHaveLength(2);

    const twice = client([networkError('ECONNREFUSED'), networkError('ECONNREFUSED')]);
    await expect(twice.c.brain('GET', 'status')).rejects.toThrow(
      'cannot reach the server at brain.example.test (ECONNREFUSED)',
    );
    expect(twice.calls).toHaveLength(2);

    const post = client([networkError('ECONNRESET'), jsonResponse(200, {})]);
    await expect(createRemoteEngine(post.c).renameNote('memos/a.md', 'memos/b.md')).rejects.toThrow(
      RemoteError,
    );
    expect(post.calls).toHaveLength(1);
  });

  it('reports a timeout', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const { c } = client([timeout, timeout]);
    await expect(c.brain('GET', 'status', { timeoutMs: 2000 })).rejects.toThrow(
      'the server at brain.example.test did not answer within 2 s',
    );
  });

  it('says which engine methods remote mode lacks', async () => {
    const remote = createRemoteEngine(client([]).c);
    await expect(remote.index()).rejects.toThrow(/somememos index is not available in remote mode/);
    await expect(remote.commit()).rejects.toThrow(/not available in remote mode/);
    await expect(remote.exportLog()).rejects.toThrow(/not available in remote mode/);
  });
});

describe('working-folder config', () => {
  let tmp: ReturnType<typeof tempDir>;
  beforeEach(() => {
    tmp = tempDir('somememos-remote-config-');
  });
  afterEach(() => tmp.remove());

  it('tells a remote working folder from a local brain without core parsing it', () => {
    expect(sidecarKind(tmp.dir)).toEqual({ kind: 'none' });
    const config = {
      mode: 'remote' as const,
      server: 'https://brain.example.test',
      brainId: 'garden',
      clientId: 'c-1',
      tokenFile: null,
    };
    writeWorkFolderConfig(tmp.dir, config);
    expect(sidecarKind(tmp.dir)).toEqual({ kind: 'remote', config });
    const other = join(tmp.dir, 'local');
    mkdirSync(join(other, '.somememos'), { recursive: true });
    writeFileSync(join(other, '.somememos', 'config.json'), '{"clientId":"x"}');
    expect(sidecarKind(other)).toEqual({ kind: 'local' });
    expect(() =>
      parseWorkFolderConfig({ mode: 'remote', server: 'ftp://x', brainId: 'B', clientId: '' }, 'f'),
    ).toThrow(/server: .*brainId: .*clientId/);
  });

  it('normalizes server URLs and refuses credentials in them', () => {
    expect(normalizeServerUrl('https://brain.example.test/')).toBe('https://brain.example.test');
    expect(normalizeServerUrl('http://127.0.0.1:3000/x/')).toBe('http://127.0.0.1:3000/x');
    expect(() => normalizeServerUrl(`https://u:${TOKEN}@brain.example.test`)).toThrow(
      /no credentials/,
    );
    expect(() => normalizeServerUrl('brain.example.test')).toThrow(/not a server URL/);
  });

  it('refuses to send the token over plain http except to this machine, unless allowed', async () => {
    for (const ok of [
      'https://brain.example.test',
      'http://localhost:4000',
      'http://127.0.0.1:3000/x',
      'http://[::1]:8080',
    ]) {
      expect(() => checkServerTransport(ok, false), ok).not.toThrow();
    }
    for (const bad of ['http://brain.example.test', 'http://10.0.0.5:3000', 'http://127.0.0.2']) {
      expect(() => checkServerTransport(bad, false), bad).toThrow(
        /refusing to send the token to .* over plain http:\/\/.*--allow-insecure .*SOMEMEMOS_ALLOW_INSECURE=1/,
      );
      expect(() => checkServerTransport(bad, true), bad).not.toThrow();
    }
    expect(insecureAllowed({})).toBe(false);
    expect(insecureAllowed({ SOMEMEMOS_ALLOW_INSECURE: '1' })).toBe(true);
    expect(insecureAllowed({ SOMEMEMOS_ALLOW_INSECURE: 'yes' })).toBe(false);
    expect(insecureAllowed({}, true)).toBe(true);
    // The client refuses before any request is made.
    const { fn, calls } = fakeFetch([jsonResponse(200, { status: 'ok' })]);
    expect(() =>
      createRemoteClient({
        server: 'http://brain.example.test',
        brainId: 'garden',
        token: TOKEN,
        clientId: 'c',
        fetch: fn,
      }),
    ).toThrow(/plain http/);
    expect(calls).toEqual([]);
  });

  it('reads the token from the environment or a file outside the folder, and never names it', () => {
    expect(resolveToken({ SOMEMEMOS_TOKEN: ` ${TOKEN} ` }, null, tmp.dir)).toBe(TOKEN);
    const file = join(tmp.dir, 'token');
    writeFileSync(file, `${TOKEN}\n`);
    expect(resolveToken({}, file, tmp.dir)).toBe(TOKEN);
    expect(resolveToken({ SOMEMEMOS_TOKEN_FILE: 'token' }, null, tmp.dir)).toBe(TOKEN);
    expect(() => resolveToken({}, null, tmp.dir)).toThrow(/no token: set SOMEMEMOS_TOKEN/);
    writeFileSync(file, `${TOKEN} extra\n`);
    let message = '';
    try {
      resolveToken({}, file, tmp.dir);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/must hold one token/);
    expect(message).not.toContain(TOKEN);
    expect(() => checkTokenFile(tmp.dir, 'work/token', join(tmp.dir, 'work'))).toThrow(
      /must be outside/,
    );
    expect(checkTokenFile(tmp.dir, 'token', join(tmp.dir, 'work'))).toBe(file);
  });

  it('derives a stable client id unless one is given', () => {
    const a = derivedClientId({}, '/work/a');
    expect(a).toMatch(/^cli-[0-9a-f]{16}$/);
    expect(derivedClientId({}, '/work/a')).toBe(a);
    expect(derivedClientId({}, '/work/b')).not.toBe(a);
    expect(derivedClientId({ SOMEMEMOS_CLIENT_ID: 'laptop' }, '/work/a')).toBe('laptop');
  });
});
