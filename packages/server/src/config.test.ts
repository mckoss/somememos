import { describe, expect, it } from 'vitest';
import {
  FailureLimiter,
  MIN_TOKEN_LENGTH,
  bearerToken,
  hashToken,
  parseTokens,
  tokenAuthorizer,
  tokenMatches,
} from './auth.js';
import { loadServerConfig } from './config.js';

const TOKEN = 'a-long-random-token-0123456789';

describe('loadServerConfig', () => {
  it('serves without a database when DATABASE_URL is unset', () => {
    const r = loadServerConfig({});
    expect(r).toMatchObject({ ok: true, config: { databaseUrl: null, dataDir: null, port: null } });
  });

  it('requires a data directory and a token with a database, and checks every value', () => {
    const r = loadServerConfig({ DATABASE_URL: 'postgres://db/x', PORT: 'eighty' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.join('\n')).toMatch(/SOMEMEMOS_DATA_DIR is not set/);
    expect(r.problems.join('\n')).toMatch(/SOMEMEMOS_TOKEN is not set/);
    expect(r.problems.join('\n')).toMatch(/PORT must be an integer/);
    const bad = loadServerConfig({
      DATABASE_URL: 'mysql://db/x',
      SOMEMEMOS_DATA_DIR: '/data',
      SOMEMEMOS_TOKEN: 'short',
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.problems.join('\n')).toMatch(/postgres:\/\//);
    expect(bad.problems.join('\n')).toMatch(new RegExp(`shorter than ${MIN_TOKEN_LENGTH}`));
    expect(bad.problems.join('\n')).not.toContain('short,'); // never echoes a token
  });

  it('accepts a full configuration', () => {
    const r = loadServerConfig({
      DATABASE_URL: 'postgresql://u:p@db:5432/somememos',
      SOMEMEMOS_DATA_DIR: 'relative/data',
      SOMEMEMOS_TOKEN: `${TOKEN}, ${hashToken('another-long-random-token-xyz')}`,
      PORT: '3000',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.dataDir?.startsWith('/')).toBe(true);
    expect(r.config.tokens.digests).toHaveLength(2);
    expect(r.config.port).toBe(3000);
  });
});

describe('tokens', () => {
  it('matches raw and hashed tokens, in constant time over the list', () => {
    const { tokens, problems } = parseTokens(
      `${TOKEN},${hashToken('second-token-abcdefghijklmnop')}`,
    );
    expect(problems).toEqual([]);
    expect(tokenMatches(tokens, TOKEN)).toBe(true);
    expect(tokenMatches(tokens, 'second-token-abcdefghijklmnop')).toBe(true);
    expect(tokenMatches(tokens, `${TOKEN}x`)).toBe(false);
    expect(parseTokens('sha256:abc').problems).toHaveLength(1);
  });

  it('reads the bearer token and authorizes the owner', async () => {
    const auth = tokenAuthorizer(parseTokens(TOKEN).tokens);
    const req = (h?: string) =>
      new Request('http://x/api', h ? { headers: { authorization: h } } : {});
    expect(bearerToken(req(`Bearer ${TOKEN}`))).toBe(TOKEN);
    expect(bearerToken(req(`Basic ${TOKEN}`))).toBeNull();
    expect(await auth.authorize(req(`Bearer ${TOKEN}`))).toEqual({ userId: 'owner' });
    expect(await auth.authorize(req('Bearer wrong'))).toBeNull();
    expect(await auth.authorize(req())).toBeNull();
    expect(await tokenAuthorizer({ digests: [] }).authorize(req(`Bearer ${TOKEN}`))).toBeNull();
  });

  it('limits failed attempts per address and in total, for a window', () => {
    let t = 0;
    const limiter = new FailureLimiter({
      perAddress: 2,
      total: 3,
      windowMs: 10_000,
      spacingMs: 100,
      maxQueueMs: 250,
      now: () => t,
    });
    const now = { kind: 'check', delayMs: 0 };
    limiter.fail('a');
    expect(limiter.throttled('a')).toBe(false);
    expect(limiter.admit('a')).toEqual(now);
    limiter.fail('a');
    // Over its own limit: 'a' is spaced out, never refused outright…
    expect(limiter.throttled('a')).toBe(true);
    expect(limiter.admit('a')).toEqual(now);
    expect(limiter.admit('a')).toEqual({ kind: 'check', delayMs: 100 });
    expect(limiter.admit('a')).toEqual({ kind: 'check', delayMs: 200 });
    // …unless it floods its own queue.
    expect(limiter.admit('a')).toEqual({ kind: 'refuse', retryAfter: 1 });
    // Another address is untouched.
    expect(limiter.admit('b')).toEqual(now);
    limiter.fail('b');
    // The total is reached: addresses that failed are throttled, a clean one is not.
    expect(limiter.throttled('b')).toBe(true);
    expect(limiter.throttled('c')).toBe(false);
    expect(limiter.admit('c')).toEqual(now);
    expect(limiter.retryAfter()).toBe(10);
    t = 10_000;
    expect(limiter.throttled('a')).toBe(false);
    expect(limiter.admit('a')).toEqual(now);
  });
});
