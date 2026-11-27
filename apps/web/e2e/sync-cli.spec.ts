// A smoke test of every remote CLI command against the real built app
// (`node build`, with SvelteKit in front of the API, a real Postgres and git;
// playwright.sync.config.ts). The CLI's own tests mount the API handler
// without SvelteKit, so they cannot see what SvelteKit refuses (a body-less
// DELETE without a content type, for one). Runs the built CLI
// (packages/cli/bin, after `npm run build`) as a separate process. Invented
// content only.

import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { TEST_TOKEN, baseURL, skipWithoutServer, uniqueBrainId } from './sync-fixtures.ts';

skipWithoutServer();

const CLI = join(import.meta.dirname, '../../../packages/cli/bin/somememos.js');
const run = promisify(execFile);

test('every remote command works against the built app', async ({
  browserName: _browser,
}, info) => {
  test.skip(info.project.name !== 'desktop', 'the CLI has no viewport; one run is enough');
  test.setTimeout(180_000);
  const brainId = uniqueBrainId(info, 'cli');
  const created = await fetch(`${baseURL()}/api/brains`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ id: brainId }),
  });
  expect(created.status).toBe(201);

  const tmp = mkdtempSync(join(tmpdir(), 'somememos-cli-smoke-'));
  try {
    const home = join(tmp, 'home');
    const cwd = join(tmp, 'agent');
    mkdirSync(home);
    mkdirSync(cwd);
    const envOnly = {
      ...process.env,
      HOME: home,
      SOMEMEMOS_SERVER: baseURL(),
      SOMEMEMOS_BRAIN_ID: brainId,
      SOMEMEMOS_TOKEN: TEST_TOKEN,
    };
    const cli = async (args: string[], dir = cwd, env: NodeJS.ProcessEnv = envOnly) => {
      try {
        const r = await run(process.execPath, [CLI, ...args], { cwd: dir, env });
        return { code: 0, stdout: r.stdout, stderr: r.stderr };
      } catch (error) {
        const e = error as { code?: number; stdout?: string; stderr?: string };
        return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
      }
    };
    const ok = async (args: string[], dir = cwd, env: NodeJS.ProcessEnv = envOnly) => {
      const r = await cli(args, dir, env);
      expect(r.code, `${args.join(' ')}: ${r.stderr}`).toBe(0);
      expect(r.stderr, args.join(' ')).not.toMatch(/HTTP 403|forbidden/i);
      return r;
    };

    // Remote mode from the environment alone (the working folder is ~/somememos/<brain>).
    const work = join(home, 'somememos', brainId);
    expect((await ok(['diary'])).stdout).toMatch(new RegExp(`^${work}/diary/`));
    mkdirSync(join(work, 'memos'), { recursive: true });
    writeFileSync(join(work, 'memos/kettle.md'), '# Kettle\n\nboiling water, see [[teapot]]\n');
    writeFileSync(join(work, 'memos/teapot.md'), '# Teapot\n\nloose leaves\n');
    expect((await ok(['commit', '-m', 'ingest two notes'])).stdout).toMatch(/committed 2 notes/);
    expect((await ok(['search', 'kettle'])).stdout).toMatch(/^memos\/kettle\.md/m);
    await ok(['hot']);
    await ok(['trending']);
    await ok(['neglected']);
    expect((await ok(['read', 'memos/teapot.md'])).stdout).toContain('loose leaves');
    expect((await ok(['log'])).stdout).toContain('two notes');
    await ok(['status']);
    expect((await ok(['config'])).stdout).toContain('folder roles');
    expect(
      (await ok(['mv', 'memos/teapot.md', 'memos/pot.md', '-m', 'update rename'])).stdout,
    ).toBe('renamed memos/teapot.md -> memos/pot.md\n');
    expect((await ok(['rm', 'memos/pot.md', '-m', 'lint remove'])).stdout).toBe(
      'deleted memos/pot.md\n',
    );
    writeFileSync(join(work, 'memos/kettle.md'), '# Kettle\n\nchanged\n');
    await ok(['commit', '-m', 'update kettle']);
    const history = (await ok(['history', 'memos/kettle.md', '--json'])).stdout;
    const versions = (JSON.parse(history) as { versions: { commit: string }[] }).versions;
    expect(versions.length).toBe(2);
    await ok(['restore', 'memos/kettle.md', (versions[1] as { commit: string }).commit]);
    expect((await ok(['read', 'memos/kettle.md'])).stdout).toContain('boiling water');

    // A connected working folder, and an offline copy that syncs.
    const folder = join(tmp, 'folder');
    const noEnv = { ...process.env, HOME: home, SOMEMEMOS_TOKEN: TEST_TOKEN };
    await ok(['connect', baseURL(), brainId, folder], tmp, noEnv);
    await ok(['read', 'memos/kettle.md'], folder, noEnv);
    const copy = join(tmp, 'copy');
    await ok(['clone', baseURL(), brainId, copy], tmp, noEnv);
    writeFileSync(join(copy, 'memos/cup.md'), '# Cup\n');
    await ok(['commit', '-m', 'ingest cup'], copy, noEnv);
    expect((await ok(['sync'], copy, noEnv)).stdout).toMatch(/pushed 1 edit \(1 applied\)/);
    await ok(['config', 'push'], copy, noEnv);
    await ok(['config', 'pull'], copy, noEnv);
    expect((await ok(['read', 'memos/cup.md'], folder, noEnv)).stdout).toBe('# Cup\n');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
