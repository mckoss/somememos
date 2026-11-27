import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXIT_OK, EXIT_USAGE, run } from './index.js';
import type { Context } from './index.js';

const rootVersion = (
  JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

function fakeContext() {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: Context = {
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
    cwd: '/nonexistent',
    env: {},
  };
  return { ctx, stdout: () => out.join(''), stderr: () => err.join('') };
}

describe('somememos', () => {
  it('prints the root package.json version for --version', async () => {
    const io = fakeContext();
    expect(await run(['--version'], io.ctx)).toBe(EXIT_OK);
    expect(io.stdout()).toBe(`${rootVersion}\n`);
    expect(io.stderr()).toBe('');
  });

  it('accepts -v as well', async () => {
    const io = fakeContext();
    expect(await run(['-v'], io.ctx)).toBe(EXIT_OK);
    expect(io.stdout()).toBe(`${rootVersion}\n`);
  });

  it('prints usage for --help', async () => {
    const io = fakeContext();
    expect(await run(['--help'], io.ctx)).toBe(EXIT_OK);
    expect(io.stdout()).toContain('Usage:');
    expect(io.stdout()).toContain('somememos <command>');
    expect(io.stderr()).toBe('');
  });

  it('prints usage with no arguments', async () => {
    const io = fakeContext();
    expect(await run([], io.ctx)).toBe(EXIT_OK);
    expect(io.stdout()).toContain('Usage:');
  });

  it('exits 2 with a message on stderr for an unknown command', async () => {
    const io = fakeContext();
    expect(await run(['frobnicate'], io.ctx)).toBe(EXIT_USAGE);
    expect(io.stdout()).toBe('');
    expect(io.stderr()).toContain("unknown command 'frobnicate'");
  });

  it('exits 2 for an unknown global option', async () => {
    const io = fakeContext();
    expect(await run(['--nope'], io.ctx)).toBe(EXIT_USAGE);
    expect(io.stderr()).toContain('--nope');
  });

  it('exits 2 for help on an unknown command', async () => {
    const io = fakeContext();
    expect(await run(['help', 'frobnicate'], io.ctx)).toBe(EXIT_USAGE);
  });
});
