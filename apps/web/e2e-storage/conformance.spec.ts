// The shared conformance suites and the driver tests, run inside a browser
// worker against the WebAssembly SQLite driver on OPFS. Each suite test is
// reported as its own step; the Playwright test fails if any of them fails.

import { expect, test, type Page } from '@playwright/test';
import { harnessUrl } from './fixtures.ts';

interface Listed {
  id: number;
  name: string;
}
interface Result {
  id: number;
  name: string;
  status: 'passed' | 'failed';
  ms: number;
  error?: string;
}

type HarnessWindow = {
  harness: {
    list(): Promise<Listed[]>;
    run(id: number): Promise<Result>;
    info(): Promise<{ sqlite: string; vfs: string }>;
    probe(): number;
    probeCall(i: number, request: unknown): Promise<unknown>;
    stopProbe(i: number): void;
  };
};

async function openHarness(page: Page): Promise<void> {
  await page.goto(harnessUrl());
  await expect(page.locator('#status')).toHaveText('ready');
}

async function runSuite(page: Page, prefix: string): Promise<void> {
  const all = await page.evaluate(() => (window as unknown as HarnessWindow).harness.list());
  const tests = all.filter((t) => t.name.startsWith(prefix));
  expect(tests.length, `tests named "${prefix}…"`).toBeGreaterThan(0);
  const failed: Result[] = [];
  let ms = 0;
  for (const t of tests) {
    await test.step(t.name.slice(prefix.length + 3) || t.name, async () => {
      const result = await page.evaluate(
        (id) => (window as unknown as HarnessWindow).harness.run(id),
        t.id,
      );
      ms += result.ms;
      if (result.status === 'failed') failed.push(result);
      expect.soft(result.status, result.error).toBe('passed');
    });
  }
  test.info().annotations.push({
    type: 'conformance',
    description: `${prefix}: ${tests.length - failed.length}/${tests.length} passed in ${ms} ms`,
  });
  console.log(`${prefix}: ${tests.length - failed.length}/${tests.length} passed in ${ms} ms`);
  for (const f of failed) console.log(`FAILED ${f.name}\n${f.error}`);
}

test.describe('conformance in the browser', () => {
  test.setTimeout(600_000);

  test('reports the SQLite build and VFS', async ({ page }) => {
    await openHarness(page);
    const info = await page.evaluate(() => (window as unknown as HarnessWindow).harness.info());
    console.log(`SQLite ${info.sqlite}, VFS ${info.vfs}`);
    expect(info.vfs).toBe('opfs-sahpool');
  });

  test('driver guarantees on OPFS', async ({ page }) => {
    await openHarness(page);
    await runSuite(page, 'sqlite driver: oo1 on OPFS (opfs-sahpool)');
  });

  test('storage conformance on OPFS', async ({ page }) => {
    await openHarness(page);
    await runSuite(page, 'storage conformance: sqlite-wasm on OPFS (opfs-sahpool)');
  });

  test('engine conformance on OPFS', async ({ page }) => {
    await openHarness(page);
    await runSuite(page, 'engine conformance: sqlite-wasm on OPFS, content table');
  });

  test('the in-memory reference passes through the same shim', async ({ page }) => {
    await openHarness(page);
    await runSuite(page, 'storage conformance: memory reference (checks the vitest shim)');
    await runSuite(page, 'engine conformance: memory reference (checks the vitest shim)');
  });

  test('a second worker cannot take the SAH pool, and wipes nothing trying', async ({ page }) => {
    await openHarness(page);
    const result = await page.evaluate(async () => {
      const h = (window as unknown as HarnessWindow).harness;
      const a = h.probe();
      const b = h.probe();
      await h.probeCall(a, { cmd: 'hold', value: 'kept' });
      const second = (await h.probeCall(b, { cmd: 'try-open', busyWaitMs: 300 })) as {
        ok: boolean;
        name?: string;
      };
      const stillThere = await h.probeCall(a, { cmd: 'read' });
      // Once the first worker is gone, the second gets the files and the data.
      h.stopProbe(a);
      const third = (await h.probeCall(b, { cmd: 'try-open', busyWaitMs: 10_000 })) as {
        ok: boolean;
      };
      const after = third.ok ? await h.probeCall(b, { cmd: 'read' }) : null;
      return { second, stillThere, third, after };
    });
    expect(result.second).toMatchObject({ ok: false, name: 'StorageBusyError' });
    expect(result.stillThere).toEqual({ v: 'kept' });
    expect(result.third).toEqual({ ok: true });
    expect(result.after).toEqual({ v: 'kept' });
  });
});
