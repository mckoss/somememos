// Helpers for the sync end-to-end tests: devices (browser contexts), the
// connect flow through the UI, the sync status, and the server's own view.

import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { clientGo, engineCall, importBrain, status, type Status } from './fixtures.ts';
import { TEST_TOKEN } from './sync-server.ts';

export { TEST_TOKEN };

/** Skips the calling test file when there is no Postgres (see sync-setup.ts). */
export function skipWithoutServer(): void {
  test.skip(!!process.env.SYNC_E2E_SKIP, process.env.SYNC_E2E_SKIP ?? '');
}

export const baseURL = (): string => `http://127.0.0.1:${process.env.SYNC_E2E_PORT}`;

/** A brain id no other test uses. */
export function uniqueBrainId(info: TestInfo, label: string): string {
  return `${label}-${info.project.name}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface Device {
  readonly context: BrowserContext;
  readonly page: Page;
}

/** A second device: a fresh browser context with the project's viewport. */
export async function newDevice(
  browser: Browser,
  info: TestInfo,
  url = baseURL(),
): Promise<Device> {
  const use = info.project.use;
  const context = await browser.newContext({
    baseURL: url,
    viewport: use.viewport ?? null,
    isMobile: use.isMobile ?? false,
    hasTouch: use.hasTouch ?? false,
    deviceScaleFactor: 2,
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  return { context, page };
}

export interface SyncViewLike {
  connected: boolean;
  brainId: string | null;
  tokenHint: string | null;
  indicator: string;
  running: boolean;
  autoSync: boolean;
  failures: number;
  nextAttemptAt: number | null;
  conflicts: number;
  pending: { notes: number; events: number; changes: number };
  problem: { kind: string; message: string } | null;
  lastRun: { rounds: number } | null;
}

type SyncCall = 'status' | 'syncNow' | 'conflicts' | 'disconnect';

/** Calls `host.sync.<method>` in the page. */
export async function syncCall<T = SyncViewLike>(page: Page, method: SyncCall): Promise<T> {
  return page.evaluate(
    (m) =>
      (
        globalThis as unknown as {
          somememos: { host: { sync: Record<string, () => Promise<unknown>> } };
        }
      ).somememos.host.sync[m]!(),
    method,
  ) as Promise<T>;
}

/** Opens More → Sync (client-side navigation when the app is already open). */
export async function openSyncSettings(page: Page): Promise<void> {
  if (page.url().startsWith('http')) await clientGo(page, '/more#sync');
  else await page.goto('/more#sync');
  await page.waitForFunction(() => 'somememos' in globalThis);
  await expect(page.getByRole('heading', { name: 'Sync', exact: true })).toBeVisible();
}

/**
 * Connects through More → Sync: token, then an existing brain or a new one,
 * then the plan (checked against `kind`), then confirm.
 */
export async function connectViaUi(
  page: Page,
  options: {
    brain: { existing: string } | { create: string };
    kind: string;
    token?: string;
    before?: (step: 'token' | 'choose' | 'plan') => Promise<void>;
  },
): Promise<void> {
  await openSyncSettings(page);
  const section = page.locator('#sync');
  await section.getByTestId('sync-token').fill(options.token ?? TEST_TOKEN);
  await options.before?.('token');
  await section.getByRole('button', { name: 'Continue' }).click();
  await expect(section.getByText('Which brain should this device sync with?')).toBeVisible();
  if ('existing' in options.brain) {
    await section.getByRole('radio', { name: new RegExp(`^${options.brain.existing}\\b`) }).check();
  } else {
    await section.getByRole('radio', { name: 'A new brain on the server' }).check();
    await section.getByTestId('sync-new-name').fill(options.brain.create);
  }
  await options.before?.('choose');
  await section.getByRole('button', { name: 'Next' }).click();
  const plan = section.getByTestId('sync-plan');
  await expect(plan).toHaveAttribute('data-kind', options.kind);
  await options.before?.('plan');
  await section.getByTestId('sync-confirm').click();
  await expect(section.getByTestId('sync-status')).toBeVisible();
}

/** Waits until the header says synced (the first sync has finished, nothing waiting). */
export async function expectSynced(page: Page): Promise<void> {
  await expect(page.getByTestId('sync-indicator')).toHaveAttribute('data-state', 'synced', {
    timeout: 60_000,
  });
}

/** The server's engine status for a brain. */
export async function serverStatus(brainId: string): Promise<Status & { changes: number }> {
  const res = await fetch(`${baseURL()}/api/brains/${brainId}/status`, {
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Status & { changes: number };
}

/** Device A with the invented brain imported and uploaded to a new brain; device B downloaded it. */
export async function twoDevices(
  browser: Browser,
  page: Page,
  info: TestInfo,
  label: string,
  opts: { blog?: boolean } = {},
): Promise<{ a: Page; b: Device; brainId: string }> {
  const brainId = uniqueBrainId(info, label);
  await importBrain(page, opts);
  await connectViaUi(page, { brain: { create: brainId }, kind: 'create-upload' });
  await expectSynced(page);
  const b = await newDevice(browser, info);
  await connectViaUi(b.page, { brain: { existing: brainId }, kind: 'download' });
  await expectSynced(b.page);
  return { a: page, b, brainId };
}

export { clientGo, engineCall, status };
