// The one-file build (scripts/bundle.mjs; IMPLEMENTATION.md task 4.1): the
// bundle, copied alone into an empty directory with no node_modules, runs
// --version, init, index and search, and (with the test database) a remote
// command against a real server. All content is invented.

import { execFile, execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tempDir } from './brain/testing.js';
import { TEST_TOKEN, type TestServer, describePg, startTestServer } from './testing/server.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, '..');
const rootVersion = (
  JSON.parse(readFileSync(join(pkgDir, '..', '..', 'package.json'), 'utf8')) as { version: string }
).version;

let tmp: ReturnType<typeof tempDir>;
let bin: string;
let run: (
  args: string[],
  env?: Record<string, string>,
) => Promise<{ code: number; stdout: string; stderr: string }>;

beforeAll(() => {
  tmp = tempDir('somememos-bundle-');
  const built = join(tmp.dir, 'build', 'somememos.mjs');
  execFileSync(process.execPath, [join(pkgDir, 'scripts', 'bundle.mjs'), '--out', built], {
    stdio: 'pipe',
  });
  // Alone in an empty directory: no package.json, no node_modules anywhere above.
  const dir = join(tmp.dir, 'empty');
  mkdirSync(dir);
  bin = join(dir, 'somememos');
  copyFileSync(built, bin);
  execFileSync('chmod', ['+x', bin]);
  run = (args, env = {}) =>
    new Promise((resolve) => {
      execFile(
        bin,
        args,
        {
          cwd: dir,
          env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: tmp.dir, ...env },
          encoding: 'utf8',
        },
        (error, stdout, stderr) =>
          resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
      );
    });
}, 120_000);
afterAll(() => tmp.remove());

describe('the one-file build', () => {
  it('is one executable file starting with a node shebang', () => {
    const text = readFileSync(bin, 'utf8');
    expect(text.startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(statSync(bin).mode & 0o111).not.toBe(0);
    expect(text).not.toMatch(/from ["']@somememos\//);
  });

  // Four Node processes started in sequence: well under a second each when
  // idle, slower on a loaded machine.
  it(
    'runs --version, init, index and search with nothing else installed',
    { timeout: 30_000 },
    async () => {
      expect(await run(['--version'])).toEqual({ code: 0, stdout: `${rootVersion}\n`, stderr: '' });
      const init = await run(['init', 'brain']);
      expect(init.code, init.stderr).toBe(0);
      writeFileSync(
        join(dirname(bin), 'brain', 'memos', 'kiln.md'),
        '# Kiln log\n\nThe glaze test at cone six came out a deep celadon.\n',
      );
      const index = await run(['index', '--brain', 'brain']);
      expect(index.code, index.stderr).toBe(0);
      expect(index.stdout).toMatch(/indexed 1 note/);
      const search = await run(['search', 'celadon', '--brain', 'brain']);
      expect(search.code, search.stderr).toBe(0);
      expect(search.stdout).toBe(
        `${join(dirname(bin), 'brain', 'memos', 'kiln.md')}  Kiln log The glaze test at cone six came out a deep celadon.\n`,
      );
    },
  );
});

describePg('the one-file build in remote mode', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer({ now: Math.floor(Date.now() / 1000) });
    await server.createBrain('pottery', { memo: ['memos/'] });
    const r = await server.request('PUT', '/api/brains/pottery/notes/memos/wheel.md', {
      text: '# Wheel\n\nCentering clay on the wheel.\n',
      baseHash: null,
    });
    expect(r.status).toBe(200);
  }, 60_000);
  afterAll(() => server?.close());

  it('searches a brain on a server from the environment alone', { timeout: 30_000 }, async () => {
    const env = {
      SOMEMEMOS_SERVER: server.url,
      SOMEMEMOS_BRAIN_ID: 'pottery',
      SOMEMEMOS_TOKEN: TEST_TOKEN,
      SOMEMEMOS_WORKDIR: join(tmp.dir, 'work'),
    };
    const search = await run(['search', 'centering'], env);
    expect(search.code, search.stderr).toBe(0);
    expect(search.stdout).toBe(
      `${join(tmp.dir, 'work', 'memos/wheel.md')}  Wheel Centering clay on the wheel.\n`,
    );
    const hot = await run(['hot'], env);
    expect(hot.code, hot.stderr).toBe(0);
    expect(`${hot.stdout}${hot.stderr}`).not.toContain(TEST_TOKEN);
  });
});
