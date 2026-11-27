// The working folder's manifest under concurrent CLI processes: several OS
// processes updating one manifest at once lose no update (./lock.ts), and a
// lock left by a process that died is recovered. Invented paths only.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../brain/testing.js';
import { LockTimeoutError, withFileLock } from './lock.js';
import { openWorkFolder } from './workfolder.js';

const here = dirname(fileURLToPath(import.meta.url));
const workfolderUrl = pathToFileURL(join(here, 'workfolder.ts')).href;
const TARGET = { server: 'https://brain.example.test', brainId: 'garden' };

// Lets a plain `node` child load this package's TypeScript source (as in
// ../indexer/concurrency.test.ts): `./x.js` imports resolve to `./x.ts`.
const HOOKS = `
import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && specifier.endsWith('.js')) {
        return next(specifier.slice(0, -3) + '.ts', context);
      }
      throw error;
    }
  },
});
`;

// Waits for the barrier file, then makes `count` manifest updates, each adding one entry.
const WORKER = `
const { openWorkFolder } = await import(${JSON.stringify(workfolderUrl)});
const { existsSync, writeFileSync } = await import('node:fs');
const [root, who, count, barrier] = process.argv.slice(1);
writeFileSync(barrier + '.ready.' + process.pid, '');
while (!existsSync(barrier)) await new Promise((r) => setTimeout(r, 1));
const folder = openWorkFolder(root, ${JSON.stringify(TARGET)});
for (let i = 0; i < Number(count); i++) {
  folder.update((notes) => {
    notes['memos/' + who + '-' + i + '.md'] = { base: 'b'.repeat(64), fingerprint: null };
  });
}
`;

const NODE_ARGS = [
  '--conditions=source',
  '--experimental-transform-types',
  '--disable-warning=ExperimentalWarning',
  `--import=data:text/javascript,${encodeURIComponent(HOOKS)}`,
  '--input-type=module',
  '-e',
];

function worker(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...NODE_ARGS, WORKER, '--', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

let tmp: ReturnType<typeof tempDir>;
afterEach(() => tmp?.remove());

describe('the working folder manifest', () => {
  it('loses no update when several processes write it at once', { timeout: 120_000 }, async () => {
    tmp = tempDir('somememos-lock-');
    const root = join(tmp.dir, 'work');
    const barrier = join(tmp.dir, 'go');
    const processes = 6;
    const each = 25;
    const runs = Array.from({ length: processes }, (_, i) =>
      worker([root, `p${i}`, String(each), barrier]),
    );
    const deadline = Date.now() + 60_000;
    while (readdirSync(tmp.dir).filter((f) => f.startsWith('go.ready.')).length < processes) {
      if (Date.now() > deadline) throw new Error('the workers never became ready');
      await new Promise((r) => setTimeout(r, 5));
    }
    writeFileSync(barrier, '');
    const results = await Promise.all(runs);
    for (const r of results) expect(r.code, r.stderr).toBe(0);
    const manifest = openWorkFolder(root, TARGET).read();
    expect(Object.keys(manifest.notes)).toHaveLength(processes * each);
    expect(existsSync(`${join(root, '.somememos', 'manifest.json')}.lock`)).toBe(false);
  });

  it('recovers a lock left by a process that died, or one that is too old', () => {
    tmp = tempDir('somememos-lock-');
    const file = join(tmp.dir, 'manifest.json');
    // A real process that has exited: its pid is free.
    const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
      encoding: 'utf8',
    });
    const deadPid = Number(gone.stdout);
    const host = hostname();
    writeFileSync(`${file}.lock`, JSON.stringify({ pid: deadPid, host, token: 'left-over' }));
    const started = Date.now();
    expect(withFileLock(file, () => 'ran', { waitMs: 5_000 })).toBe('ran');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(existsSync(`${file}.lock`)).toBe(false);

    // Held by a live process (this one), but far too old.
    writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, host, token: 'old' }));
    const past = new Date(Date.now() - 120_000);
    utimesSync(`${file}.lock`, past, past);
    expect(withFileLock(file, () => 'ran again', { waitMs: 5_000 })).toBe('ran again');
  });

  it('waits for a live holder, then gives up with a clear error', () => {
    tmp = tempDir('somememos-lock-');
    const file = join(tmp.dir, 'manifest.json');
    const host = hostname();
    writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, host, token: 'held' }));
    expect(() => withFileLock(file, () => 'never', { waitMs: 200 })).toThrow(LockTimeoutError);
    // The holder's lock is not removed by the waiter that gave up.
    expect(JSON.parse(readFileSync(`${file}.lock`, 'utf8')).token).toBe('held');
  });
});
