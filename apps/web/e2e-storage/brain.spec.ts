// The on-device brain in the production build: persistence on OPFS, reset,
// offline start, several tabs, a large import, the in-memory fallback and
// timings. Tests tagged @phone also run at a phone viewport. All notes are
// invented (`generateBrain` and fixtures.ts).

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';
import { generateBrain } from '../../../packages/core/src/testing/index.ts';
import { inventedNotes, openHost } from './fixtures.ts';

/** Runs `fn` in the page with the host (`openHost`) as its first argument. */
async function withHost<R, A = undefined>(
  page: Page,
  fn: (host: HostLike, arg: A) => Promise<R>,
  arg?: A,
): Promise<R> {
  const handle = await page.evaluateHandle(
    () => (window as unknown as { __host: HostLike }).__host,
  );
  try {
    // `arg` is plain data (structured-clone safe), so it arrives unchanged.
    const run = fn as unknown as (host: HostLike, arg: unknown) => Promise<R>;
    return await handle.evaluate(run, arg as unknown);
  } finally {
    await handle.dispose();
  }
}

/** The parts of BrainHost the tests use, loosely typed for `page.evaluate`. */
interface HostLike {
  engine: {
    config: { roles: Record<string, string[]>; clientId: string };
    search(q: string, o?: unknown): Promise<{ results: { path: string | null }[] }>;
    readNote(p: string, o?: unknown): Promise<{ text: string; hash: string }>;
    saveNote(p: string, t: string, o?: unknown): Promise<{ status: string; hash?: string }>;
    status(): Promise<{ notes: { total: number }; events: Record<string, number> }>;
    noteTitles(): Promise<{ path: string }[]>;
  };
  importFiles(
    files: unknown,
    o?: unknown,
  ): Promise<{
    imported: number;
    skipped: number;
    index: { baseline: boolean; warnings: string[]; events: Record<string, number> };
  }>;
  updateConfig(c: unknown): Promise<void>;
  storageInfo(): Promise<{ kind: string; persisted: boolean; runsIn: string; reason?: string }>;
  requestPersistence(): Promise<boolean>;
  reset(): Promise<void>;
  subscribe(l: (c: { source: string; operation: string }) => void): () => void;
}

async function load(page: Page, path = '/'): Promise<number> {
  await page.goto(path);
  return openHost(page);
}

function note(label: string, value: number): void {
  console.log(`${label}: ${value.toFixed(1)} ms`);
  test.info().annotations.push({ type: 'timing', description: `${label}: ${value.toFixed(1)} ms` });
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;

test('keeps notes on the device across a reload, and reset clears them @phone', async ({
  page,
}) => {
  await load(page);
  const first = await withHost(
    page,
    async (h, notes) => {
      const imported = await h.importFiles(notes);
      const saved = await h.engine.saveNote(
        'memos/kept.md',
        '# Kept\n\nA lantern in the harbor.\n',
      );
      return { imported, saved, info: await h.storageInfo(), clientId: h.engine.config.clientId };
    },
    inventedNotes(30),
  );
  expect(first.imported).toMatchObject({ imported: 30, skipped: 0 });
  expect(first.imported.index.baseline).toBe(true);
  expect(first.saved.status).toBe('saved');
  expect(first.info).toMatchObject({ kind: 'device', runsIn: 'this-tab' });

  await page.reload();
  await openHost(page);
  const after = await withHost(page, async (h) => ({
    text: (await h.engine.readNote('memos/kept.md', { record: false })).text,
    hits: (await h.engine.search('lantern')).results.map((r) => r.path),
    total: (await h.engine.status()).notes.total,
    clientId: h.engine.config.clientId,
  }));
  expect(after.text).toBe('# Kept\n\nA lantern in the harbor.\n');
  expect(after.hits).toContain('memos/kept.md');
  expect(after.total).toBe(31);
  expect(after.clientId).toBe(first.clientId);

  await withHost(page, (h) => h.reset());
  const cleared = await withHost(page, async (h) => ({
    total: (await h.engine.status()).notes.total,
    clientId: h.engine.config.clientId,
  }));
  expect(cleared.total).toBe(0);
  expect(cleared.clientId).not.toBe(first.clientId);
  await page.reload();
  await openHost(page);
  expect(await withHost(page, async (h) => (await h.engine.status()).notes.total)).toBe(0);
});

test('takes the first import as the baseline, then logs later imports', async ({ page }) => {
  await load(page);
  const result = await withHost(page, async (h) => {
    // An index pass over the empty brain first, as the UI may run one.
    await h.engine.search('');
    const first = await h.importFiles([
      { path: 'memos/a.md', text: '# A\n\nSee [[b]].\n', mtime: 1_790_000_000 },
      { path: 'memos/b.md', text: '# B\n', mtime: 1_790_000_000 },
      { path: 'memos/photo.png', text: 'not markdown' },
      { path: '../outside.md', text: '# Outside\n' },
    ]);
    const afterFirst = (await h.engine.status()).events;
    const second = await h.importFiles([{ path: 'memos/c.md', text: '# C\n\n[[a]]\n' }]);
    return { first, afterFirst, second, events: (await h.engine.status()).events };
  });
  expect(result.first).toMatchObject({ imported: 2, skipped: 2 });
  expect(result.first.index.baseline).toBe(true);
  expect(result.first.index.warnings).toEqual([]);
  expect(Object.values(result.afterFirst).every((n) => n === 0)).toBe(true);
  expect(result.second.index.baseline).toBe(false);
  expect(result.events).toMatchObject({ edit: 1, mention: 1 });
});

test('updateConfig validates, persists, and drops newly excluded notes from the index', async ({
  page,
}) => {
  await load(page);
  await withHost(page, (h) =>
    h.importFiles([
      { path: 'memos/open.md', text: '# Open\n\nquartz meadow, see [[secret]]\n' },
      { path: 'memos/hidden/secret.md', text: '# Secret\n\nquartz tundra\n' },
    ]),
  );
  const bad = await withHost(page, async (h) => {
    try {
      await h.updateConfig({ ...h.engine.config, roles: { memo: 42 } });
      return null;
    } catch (error) {
      const e = error as Error & { problems?: string[] };
      return { name: e.name, problems: e.problems?.length ?? 0 };
    }
  });
  expect(bad).toMatchObject({ name: 'ConfigError' });
  expect(bad?.problems).toBeGreaterThan(0);

  const after = await withHost(page, async (h) => {
    await h.updateConfig({
      ...h.engine.config,
      roles: { ...h.engine.config.roles, excluded: ['memos/hidden/'] },
    });
    return {
      hits: (await h.engine.search('quartz')).results.map((r) => r.path),
      titles: (await h.engine.noteTitles()).map((t) => t.path),
      excluded: h.engine.config.roles.excluded,
    };
  });
  expect(after.excluded).toEqual(['memos/hidden/']);
  expect(after.hits).toEqual(['memos/open.md']);
  expect(after.titles).toEqual(['memos/open.md']);

  // Excluded paths are never stored by an import.
  const skipped = await withHost(page, (h) =>
    h.importFiles([{ path: 'memos/hidden/new.md', text: '# New secret\n\nglacier\n' }]),
  );
  expect(skipped).toMatchObject({ imported: 0, skipped: 1 });

  await page.reload();
  await openHost(page);
  const reloaded = await withHost(page, async (h) => {
    const excluded = h.engine.config.roles.excluded;
    await h.updateConfig({ ...h.engine.config, roles: { ...h.engine.config.roles, excluded: [] } });
    return {
      excluded,
      glacier: (await h.engine.search('glacier')).results.length,
      secretBack: (await h.engine.search('tundra')).results.map((r) => r.path),
    };
  });
  expect(reloaded.excluded).toEqual(['memos/hidden/']);
  expect(reloaded.glacier).toBe(0);
  // Content that was stored before the exclusion was kept, and returns.
  expect(reloaded.secretBack).toEqual(['memos/hidden/secret.md']);
});

test('sends engine errors back as EngineErrors', async ({ page }) => {
  await load(page);
  const error = await withHost(page, async (h) => {
    try {
      await h.engine.readNote('memos/none.md');
      return null;
    } catch (e) {
      const err = e as Error & { code?: string; toJSON?: () => unknown };
      return { name: err.name, code: err.code, json: typeof err.toJSON === 'function' };
    }
  });
  expect(error).toEqual({ name: 'EngineError', code: 'not-found', json: true });
});

test('opens and searches with the network off @phone', async ({ page, context }) => {
  await load(page);
  // Wait for the service worker to install and control the page.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r));
    }
  });
  await withHost(page, (h, notes) => h.importFiles(notes), inventedNotes(200));

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('body')).not.toBeEmpty();
  await openHost(page);
  const hits = await withHost(page, async (h) => (await h.engine.search('cobalt')).results.length);
  expect(hits).toBeGreaterThan(0);

  // A route this tab never visited opens from the offline shell.
  const response = await page.goto('/neglected');
  expect(response?.status()).toBe(200);
  expect(response?.fromServiceWorker()).toBe(true);
  await openHost(page);
  expect(await withHost(page, async (h) => (await h.engine.status()).notes.total)).toBe(200);
  await context.setOffline(false);
});

test('two tabs share one brain; the second takes over when the first closes', async ({
  context,
}) => {
  const a = await context.newPage();
  await load(a);
  const b = await context.newPage();
  await load(b);

  expect((await withHost(a, (h) => h.storageInfo())).runsIn).toBe('this-tab');
  expect((await withHost(b, (h) => h.storageInfo())).runsIn).toBe('other-tab');

  await a.evaluate(() => {
    const w = window as unknown as { __host: HostLike; __changes: unknown[] };
    w.__changes = [];
    w.__host.subscribe((c) => w.__changes.push(c));
  });
  const saved = await withHost(b, (h) =>
    h.engine.saveNote('memos/shared.md', '# Shared\n\nwritten in tab b\n', { baseHash: null }),
  );
  expect(saved.status).toBe('saved');
  expect(
    (await withHost(a, (h) => h.engine.readNote('memos/shared.md', { record: false }))).text,
  ).toBe('# Shared\n\nwritten in tab b\n');
  await expect
    .poll(() => a.evaluate(() => (window as unknown as { __changes: unknown[] }).__changes))
    .toContainEqual({ source: 'other-tab', operation: 'saveNote' });

  // Concurrent writes from both tabs land in one queue: one wins, one conflicts.
  const [ra, rb] = await Promise.all([
    withHost(a, (h) => h.engine.saveNote('memos/race.md', 'from a\n', { baseHash: null })),
    withHost(b, (h) => h.engine.saveNote('memos/race.md', 'from b\n', { baseHash: null })),
  ]);
  expect([ra.status, rb.status].sort()).toEqual(['conflict', 'saved']);

  await b.evaluate(() => {
    const w = window as unknown as { __host: HostLike; __changes: unknown[] };
    w.__changes = [];
    w.__host.subscribe((c) => w.__changes.push(c));
  });
  await a.close();
  await expect
    .poll(async () => (await withHost(b, (h) => h.storageInfo())).runsIn)
    .toBe('this-tab');
  // The tab that took over says so, so its UI can refresh what it shows.
  await expect
    .poll(() => b.evaluate(() => (window as unknown as { __changes: unknown[] }).__changes))
    .toContainEqual({ source: 'this-tab', operation: 'reopen' });
  const kept = await withHost(b, async (h) => ({
    shared: (await h.engine.readNote('memos/shared.md', { record: false })).text,
    total: (await h.engine.status()).notes.total,
  }));
  expect(kept).toEqual({ shared: '# Shared\n\nwritten in tab b\n', total: 2 });
});

test('imports a generated brain of thousands of notes without blocking the page', async ({
  page,
}) => {
  test.setTimeout(300_000);
  // Several synthetic brains side by side, each in its own folder.
  const files: { path: string; text: string }[] = [];
  for (let seed = 1; files.length < 3000; seed++) {
    const brain = generateBrain({ seed, steps: 400 });
    for (const [path, text] of Object.entries(brain.files)) {
      if (!path.startsWith('memos/')) continue;
      files.push({ path: `memos/b${seed}/${path.slice('memos/'.length)}`, text });
    }
  }
  const chars = files.reduce((n, f) => n + f.text.length, 0);
  await load(page);
  const result = await withHost(
    page,
    async (h, notes) => {
      // Measure the longest gap between timer ticks on the page during the import.
      let last = performance.now();
      let longest = 0;
      const timer = setInterval(() => {
        const now = performance.now();
        longest = Math.max(longest, now - last);
        last = now;
      }, 10);
      const progress: string[] = [];
      const started = performance.now();
      const r = await h.importFiles(notes, {
        onProgress: (p: { phase: string }) => progress.push(p.phase),
      });
      const ms = performance.now() - started;
      clearInterval(timer);
      return { r, ms, longest, phases: [...new Set(progress)] };
    },
    files,
  );
  console.log(`import: ${files.length} notes, ${(chars / 1e6).toFixed(1)} M chars`);
  note(`import of ${files.length} notes (write + baseline index)`, result.ms);
  note('longest main-thread gap during the import', result.longest);
  expect(result.r.imported).toBe(files.length);
  expect(result.phases).toEqual(['writing', 'indexing', 'done']);
  expect(result.longest).toBeLessThan(250);
});

test('falls back to memory when OPFS is unavailable, and says so', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(StorageManager.prototype, 'getDirectory', {
      configurable: true,
      value: () => Promise.reject(new DOMException('blocked by the test', 'SecurityError')),
    });
  });
  await load(page);
  const info = await withHost(page, async (h) => {
    await h.importFiles([{ path: 'memos/temp.md', text: '# Temp\n\nember\n' }]);
    return {
      info: await h.storageInfo(),
      hits: (await h.engine.search('ember')).results.length,
    };
  });
  expect(info.info).toMatchObject({ kind: 'memory', persisted: false, runsIn: 'this-tab' });
  expect(info.info.reason).toContain('SecurityError');
  expect(info.hits).toBe(1);
  await page.reload();
  await openHost(page);
  expect(await withHost(page, async (h) => (await h.engine.status()).notes.total)).toBe(0);
});

test('timings: cold open, search over 1,000 notes, saving a note', async ({ page }) => {
  test.setTimeout(180_000);
  const cold = await load(page);
  note('cold open (empty brain, first load of SQLite)', cold);
  await withHost(page, (h, notes) => h.importFiles(notes), inventedNotes(1000));
  await page.reload();
  note('open after reload (1,000 notes on OPFS)', await openHost(page));

  const times = await withHost(page, async (h) => {
    const queries = ['harbor', 'lantern quartz', 'ember', 'meadow orbit', 'willow', 'note'];
    const search: number[] = [];
    for (let round = 0; round < 3; round++) {
      for (const q of queries) {
        const t = performance.now();
        await h.engine.search(q, { limit: 20 });
        search.push(performance.now() - t);
      }
    }
    const save: number[] = [];
    let hash: string | null = null;
    for (let i = 0; i < 10; i++) {
      const t = performance.now();
      const r = await h.engine.saveNote('memos/timed.md', `# Timed\n\nrevision ${i}\n`, {
        baseHash: hash,
      });
      save.push(performance.now() - t);
      hash = r.hash ?? null;
    }
    return { search, save };
  });
  note('search over 1,000 notes (median)', median(times.search));
  note('search over 1,000 notes (max)', Math.max(...times.search));
  note('save a note (median)', median(times.save));
  note('save a note (max)', Math.max(...times.save));
});

test('a new app version waits until the page asks it to take over', async ({ page }) => {
  // A proxy in front of the app that can serve a changed service worker, as
  // a new deploy would (Playwright can't route a service worker's own script).
  let version: string | null = null;
  const app = test.info().project.use.baseURL as string;
  const proxy = createServer((req, res) => {
    void (async () => {
      const upstream = await fetch(new URL(req.url ?? '/', app), {
        headers: { 'accept-encoding': 'identity' },
      });
      let body = Buffer.from(await upstream.arrayBuffer());
      if (version && req.url?.startsWith('/service-worker.js')) {
        const text = body.toString('utf8').replaceAll(version, `${version}.next`);
        body = Buffer.from(`${text}\n// next version\n`);
      }
      const headers: Record<string, string> = {};
      upstream.headers.forEach((v, k) => {
        if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(k))
          headers[k] = v;
      });
      res.writeHead(upstream.status, headers).end(body);
    })().catch(() => res.writeHead(502).end());
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  try {
    await page.goto(`${origin}/`);
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r));
      }
    });
    const before = await page.evaluate(() => caches.keys());
    expect(before).toEqual([expect.stringMatching(/^somememos-app-\d/)]);

    version = (before[0] as string).slice('somememos-app-'.length);
    const state = await page.evaluate(async () => {
      const registration =
        (await navigator.serviceWorker.getRegistration()) as ServiceWorkerRegistration;
      await registration.update();
      const next = registration.installing ?? registration.waiting;
      if (next && next.state !== 'installed') {
        await new Promise<void>((resolve) =>
          next.addEventListener('statechange', () => next.state === 'installed' && resolve()),
        );
      }
      // It must stay waiting.
      await new Promise((r) => setTimeout(r, 500));
      return { waiting: Boolean(registration.waiting) };
    });
    expect(state.waiting).toBe(true);
    // The running version still has its own cache, untouched.
    expect(await page.evaluate(() => caches.keys())).toContain(before[0]);

    // What #lib/brain/updates.ts applyUpdate() does: ask it to take over.
    // The app (whose layout loads updates.ts) then reloads itself.
    const reloaded = page.waitForEvent('load');
    await page.evaluate(async () => {
      const registration =
        (await navigator.serviceWorker.getRegistration()) as ServiceWorkerRegistration;
      registration.waiting?.postMessage({ type: 'skip-waiting' });
    });
    await reloaded;
    await expect.poll(() => page.evaluate(() => caches.keys())).toEqual([`${before[0]}.next`]);
  } finally {
    await page.close();
    proxy.close();
  }
});
