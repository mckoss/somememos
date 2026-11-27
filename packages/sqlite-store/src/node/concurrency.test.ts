// Several OS processes appending events (some with the same ids) and folding
// into one brain at once: no event may be lost or counted twice
// (IMPLEMENTATION.md task 1.18, at the storage level).

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { storage } from '@somememos/core';
import { expectScoresClose } from '@somememos/core/testing/storage';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { sourceChildFlags } from './child.testing.js';
import { openSqliteFiles } from './files.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..', '..');
const storeUrl = pathToFileURL(join(here, 'index.ts')).href;

const openBrainStores = (dir: string) =>
  openSqliteFiles({ eventsPath: join(dir, 'events.sqlite'), indexPath: join(dir, 'index.sqlite') });

const WORKER = `
const [brainDir, worker, rounds, perRound] = process.argv.slice(1);
const { openSqliteFiles } = await import(${JSON.stringify(storeUrl)});
const { join } = await import('node:path');
const { storage } = await import('@somememos/core');
const items = ['memos/a.md', 'memos/b.md', 'memos/c.md', 'some key'];
const now = Math.floor(Date.now() / 1000);
const stores = openSqliteFiles({ eventsPath: join(brainDir, 'events.sqlite'), indexPath: join(brainDir, 'index.sqlite') });
let appended = 0;
let conflicts = 0;
for (let r = 0; r < Number(rounds); r++) {
  const batch = [];
  for (let j = 0; j < Number(perRound); j++) {
    const item = items[(Number(worker) * 7 + r * 3 + j) % items.length];
    const kind = ['read', 'edit', 'mention'][(r + j) % 3];
    batch.push({ id: 'w' + worker + '-' + r + '-' + j, kind, item, time: now - 1000 * j - r, client: 'w' + worker });
    // Every worker also sends the same shared events, as sync retries would.
    batch.push({ id: 'shared-' + r + '-' + j, kind: 'read', item, time: now - j, client: 'w' + worker });
  }
  if (worker === '0' && r % 5 === 4) {
    batch.push({ id: 'rename-' + r, kind: 'rename', item: 'some key', to: 'memos/key-' + r + '.md', time: now, client: 'w0' });
  }
  appended += (await stores.events.append(batch)).appended;
  conflicts += (await storage.foldPending(stores.events, stores.scores, { batchSize: 7 })).conflicts;
}
stores.close();
process.stdout.write(JSON.stringify({ appended, conflicts }));
`;

function runWorker(
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [...sourceChildFlags(), '--input-type=module', '-e', WORKER, '--', ...args],
      { cwd: packageRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'somememos-concurrency-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

it(
  'loses and double-counts nothing with several processes appending and folding',
  { timeout: 120_000 },
  async () => {
    const workers = 4;
    const rounds = 20;
    const perRound = 5;
    const results = await Promise.all(
      Array.from({ length: workers }, (_, w) =>
        runWorker([dir, String(w), String(rounds), String(perRound)]),
      ),
    );
    for (const r of results) expect(r.code, r.stderr).toBe(0);

    const own = workers * rounds * perRound;
    const shared = rounds * perRound;
    const renames = rounds / 5;
    const appended = results.reduce(
      (n, r) => n + (JSON.parse(r.stdout) as { appended: number }).appended,
      0,
    );
    expect(appended).toBe(own + shared + renames);

    const stores = openBrainStores(dir);
    try {
      const log = await stores.events.readAfter(0);
      expect(log.length).toBe(own + shared + renames);
      expect(new Set(log.map((e) => e.id)).size).toBe(log.length);
      expect(log.map((e) => e.seq)).toEqual(log.map((_, i) => i + 1));

      // Every worker folded after its last append, so the last one to finish
      // folded everything.
      expect((await stores.scores.foldState()).cursor).toBe(log.length);
      const folded = await stores.scores.getAll();

      // A fresh rebuild of the same log, in memory, gives the same scores.
      const memory = storage.createMemoryStores();
      await memory.events.append(
        log.map(({ seq: _seq, ...input }) => input as storage.LogInput),
        { now: Number.MAX_SAFE_INTEGER },
      );
      await storage.foldPending(memory.events, memory.scores);
      expectScoresClose(folded, await memory.scores.getAll());
    } finally {
      stores.close();
    }
  },
);
