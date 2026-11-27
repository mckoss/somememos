// The SAH pool's exclusive access, in a real browser: a second worker cannot
// take the pool's files while the first holds them, and wipes nothing trying.
// (The conformance suites run under Vitest's browser mode instead:
// apps/web/vitest.storage.config.ts and e2e-storage/conformance.)

import { expect, test } from '@playwright/test';
import { harnessUrl } from './fixtures.ts';

type HarnessWindow = {
  harness: {
    probe(): number;
    probeCall(i: number, request: unknown): Promise<unknown>;
    stopProbe(i: number): void;
  };
};

test('a second worker cannot take the SAH pool, and wipes nothing trying', async ({ page }) => {
  await page.goto(harnessUrl());
  await expect(page.locator('#status')).toHaveText('ready');
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
