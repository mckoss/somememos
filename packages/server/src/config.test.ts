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
    const limiter = new FailureLimiter({ perAddress: 2, total: 3, windowMs: 1000, now: () => t });
    limiter.fail('a');
    expect(limiter.blockedFor('a')).toBe(0);
    limiter.fail('a');
    expect(limiter.blockedFor('a')).toBe(1);
    expect(limiter.blockedFor('b')).toBe(0);
    limiter.fail('b');
    expect(limiter.blockedFor('c')).toBe(1);
    t = 1000;
    expect(limiter.blockedFor('a')).toBe(0);
  });
});
