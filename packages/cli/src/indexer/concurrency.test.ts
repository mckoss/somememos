// Two CLI processes running the index pass on one brain at the same time:
// every change is indexed by exactly one of them and logged exactly once.
// And a pass that dies after appending to the event log but before its index
// transaction commits logs nothing twice when it is run again.

import { spawn } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { markdown, storage } from '@somememos/core';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { tempDir, writeNote, writeTestConfig } from '../brain/testing.js';
import { openBrainStores } from '../store/index.js';
import { type IndexSummary, runIndexPass } from './pass.js';

const here = dirname(fileURLToPath(import.meta.url));
const cliUrl = pathToFileURL(join(here, '..', 'index.ts')).href;

// Lets a plain `node` child load this package's TypeScript source: imports
// written as `./x.js` resolve to `./x.ts`.
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

// With a barrier path, the child loads the CLI, signals it is ready, and
// waits for the barrier file, so that several children start at once.
const WORKER = `
const { run } = await import(${JSON.stringify(cliUrl)});
const { existsSync, writeFileSync } = await import('node:fs');
let args = process.argv.slice(1);
if (args[0] === '--barrier') {
  const barrier = args[1];
  args = args.slice(2);
  writeFileSync(barrier + '.ready.' + process.pid, '');
  while (!existsSync(barrier)) await new Promise((r) => setTimeout(r, 1));
}
process.exitCode = await run(args);
`;

/** Runs `somememos <args>` from source in a child process with `cwd`. */
export function runCli(
  cwd: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--conditions=source',
        '--experimental-transform-types',
        '--disable-warning=ExperimentalWarning',
        `--import=data:text/javascript,${encodeURIComponent(HOOKS)}`,
        '--input-type=module',
        '-e',
        WORKER,
        '--',
        ...args,
      ],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SOMEMEMOS_BRAIN: '' } },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Runs several CLI invocations that all start their command at the same moment. */
async function runTogether(cwd: string, barrier: string, invocations: string[][]) {
  const children = invocations.map((args) => runCli(cwd, ['--barrier', barrier, ...args]));
  const dir = dirname(barrier);
  const prefix = `${basename(barrier)}.ready.`;
  const deadline = Date.now() + 60_000;
  while (readdirSync(dir).filter((f) => f.startsWith(prefix)).length < invocations.length) {
    if (Date.now() > deadline) throw new Error('children never became ready');
    await new Promise((r) => setTimeout(r, 5));
  }
  writeFileSync(barrier, '');
  return Promise.all(children);
}

const ROLES = { memo: ['memos/'] };
const NOTES = 120;
const T0 = Math.floor(Date.now() / 1000) - 86_400;

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir('somememos-index-race-');
});
afterEach(() => tmp.remove());

function writeAll(dir: string, round: number): void {
  for (let i = 0; i < NOTES; i++) {
    writeNote(
      dir,
      `memos/n${i}.md`,
      `# Note ${i}\n\nRound ${round} text, see [[n${(i + round) % NOTES}]] and [[idea ${round}]].\n`,
      T0 + round * 100,
    );
  }
}

describe('concurrent index passes', () => {
  it(
    'two processes index each change once and log each event once',
    { timeout: 120_000 },
    async () => {
      const dir = tmp.dir;
      const sync = tempDir('somememos-barrier-');
      onTestFinished(() => sync.remove());
      writeTestConfig(dir, { roles: ROLES });
      writeAll(dir, 0);
      expect((await runCli(dir, ['index'])).code).toBe(0); // baseline

      const rounds = 4;
      for (let round = 1; round <= rounds; round++) {
        writeAll(dir, round);
        const results = await runTogether(dir, join(sync.dir, `go-${round}`), [
          ['index', '--json'],
          ['--json', 'status'],
        ]);
        for (const r of results) expect(r.code, r.stderr).toBe(0);
        const summaries = results.map((r) => {
          const record = JSON.parse(r.stdout) as IndexSummary & { index?: IndexSummary };
          return record.index ?? record;
        });
        // Exactly one of the two did the work; the other found it done.
        expect(
          summaries.map((s) => s.indexed).sort((a, b) => a - b),
          `round ${round}`,
        ).toEqual([0, NOTES]);
        expect(summaries.reduce((n, s) => n + s.events.edit, 0)).toBe(NOTES);
      }

      const stores = openBrainStores(dir);
      try {
        const counts = await stores.events.countByKind();
        expect(counts.edit).toBe(NOTES * rounds);
        // Each round adds one new dangling target per note and changes its note link.
        expect(counts.mention).toBe(NOTES * rounds * 2);
        const log = await stores.events.readAfter(0);
        expect(new Set(log.map((e) => e.id)).size).toBe(log.length);
        expect((await stores.scores.foldState()).cursor).toBe(log.length);
      } finally {
        stores.close();
      }
    },
  );

  it('a pass that crashes before committing the index logs nothing twice on retry', async () => {
    const dir = tmp.dir;
    const config = writeTestConfig(dir, { roles: ROLES });
    const classifier = markdown.createRoleClassifier(config.roles);
    writeAll(dir, 0);
    const stores = openBrainStores(dir);
    try {
      await runIndexPass({ root: dir, stores, config, classifier });
      writeAll(dir, 1);
      // The event log is appended inside the index transaction; make the
      // transaction fail after its body ran, as a crash before COMMIT would.
      const crashing: storage.Stores = {
        ...stores,
        async indexTransaction(fn) {
          return stores.indexTransaction(async () => {
            await fn();
            throw new Error('simulated crash');
          });
        },
      };
      await expect(
        runIndexPass({ root: dir, stores: crashing, config, classifier }),
      ).rejects.toThrow('simulated crash');
      const afterCrash = await stores.events.lastSeq();
      expect(afterCrash).toBe(NOTES * 3);
      expect(await stores.notes.getNote('memos/n0.md')).toMatchObject({ mtime: T0 }); // rolled back

      const retry = await runIndexPass({ root: dir, stores, config, classifier });
      expect(retry.indexed).toBe(NOTES);
      expect(await stores.events.lastSeq()).toBe(afterCrash); // every id was already stored
    } finally {
      stores.close();
    }
  });
});
