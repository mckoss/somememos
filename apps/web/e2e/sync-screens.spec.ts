// Screenshots of sync for review (not compared against a baseline): the
// settings, each connect flow, the header indicator's states and the
// conflict list, at a phone and a desktop size. They go to
// $SYNC_SCREENSHOT_DIR (default: under node_modules/.cache, which git ignores).

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { importBrain } from './fixtures.ts';
import {
  TEST_TOKEN,
  clientGo,
  engineCall,
  expectSynced,
  newDevice,
  openSyncSettings,
  skipWithoutServer,
  syncCall,
  uniqueBrainId,
} from './sync-fixtures.ts';

skipWithoutServer();

function shotPath(name: string, project: string): string {
  const dir =
    process.env.SYNC_SCREENSHOT_DIR ??
    join(process.cwd(), '../../node_modules/.cache/somememos-e2e/screens-sync');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${project}-${name}.png`);
}

test('screenshots of sync', async ({ browser, page }, info) => {
  test.setTimeout(240_000);
  const project = info.project.name;
  const shoot = async (target: Page | Locator, name: string) => {
    await page.waitForTimeout(150);
    await target.screenshot({ path: shotPath(name, project), animations: 'disabled' });
  };
  const section = (p: Page) => p.locator('#sync');
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  const brainId = uniqueBrainId(info, 'shots');

  // Device A: notes, not connected.
  await importBrain(page, { blog: true });
  await openSyncSettings(page);
  await section(page).scrollIntoViewIfNeeded();
  await expect(section(page).getByTestId('sync-token')).toBeVisible();
  await shoot(page, '01-settings-not-connected');

  await section(page).getByTestId('sync-token').fill(TEST_TOKEN);
  await section(page).getByRole('button', { name: 'Continue' }).click();
  await section(page).getByRole('radio', { name: 'A new brain on the server' }).check();
  await section(page).getByTestId('sync-new-name').fill(brainId);
  await shoot(section(page), '02-choose-brain-new');
  await section(page).getByRole('button', { name: 'Next' }).click();
  await expect(section(page).getByTestId('sync-plan')).toHaveAttribute(
    'data-kind',
    'create-upload',
  );
  await shoot(section(page), '03-plan-create-upload');
  await section(page).getByTestId('sync-confirm').click();
  await expectSynced(page);
  await section(page).scrollIntoViewIfNeeded();
  await shoot(page, '04-connected-synced');
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await shoot(page, '04-connected-synced-dark');
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });

  // Device B: empty, downloads (paged, so the progress shows).
  const b = await newDevice(browser, info);
  await b.page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await openSyncSettings(b.page);
  await section(b.page).getByTestId('sync-token').fill(TEST_TOKEN);
  await section(b.page).getByRole('button', { name: 'Continue' }).click();
  await section(b.page)
    .getByRole('radio', { name: new RegExp(`^${brainId}\\b`) })
    .check();
  await section(b.page).screenshot({ path: shotPath('05-choose-brain-existing', project) });
  await section(b.page).getByRole('button', { name: 'Next' }).click();
  await expect(section(b.page).getByTestId('sync-plan')).toHaveAttribute('data-kind', 'download');
  await section(b.page).screenshot({ path: shotPath('06-plan-download', project) });
  await section(b.page).getByTestId('sync-confirm').click();
  try {
    await expect(section(b.page).getByTestId('sync-progress')).toBeVisible({ timeout: 3_000 });
    await b.page.screenshot({ path: shotPath('07-downloading-progress', project) });
  } catch {
    // Too quick to catch: fine.
  }
  await expectSynced(b.page);

  // Device C: its own notes, joining the same brain: a merge, asked first.
  const c = await newDevice(browser, info);
  await c.page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await c.page.goto('/more');
  await c.page.waitForFunction(() => 'somememos' in globalThis);
  await engineCall(
    c.page,
    'saveNote',
    'memos/an-idea.md',
    '# An idea\n\nWritten on a third device.\n',
    {},
  );
  await openSyncSettings(c.page);
  await section(c.page).getByTestId('sync-token').fill(TEST_TOKEN);
  await section(c.page).getByRole('button', { name: 'Continue' }).click();
  await section(c.page)
    .getByRole('radio', { name: new RegExp(`^${brainId}\\b`) })
    .check();
  await section(c.page).getByRole('button', { name: 'Next' }).click();
  await expect(section(c.page).getByTestId('sync-plan')).toHaveAttribute('data-kind', 'merge');
  await section(c.page).screenshot({ path: shotPath('08-plan-merge', project) });
  await c.context.close();

  // Indicator states on A: waiting, offline, syncing, attention.
  const topbar = page.locator('.topbar');
  const memos = (await engineCall<{ path: string }[]>(page, 'noteTitles'))
    .map((t) => t.path)
    .filter((p) => p.startsWith('memos/'));
  const target = memos[0] as string;
  await clientGo(page, '/hot');
  await page.context().setOffline(true);
  const text = (await engineCall<{ text: string }>(page, 'readNote', target, { record: false }))
    .text;
  await engineCall(page, 'saveNote', target, `${text}\nOne more line.\n`, {});
  await expect(page.getByTestId('sync-indicator')).toHaveAttribute('data-state', 'waiting');
  await shoot(topbar, '10-indicator-waiting');
  await expect(page.getByTestId('sync-indicator')).toHaveAttribute('data-state', 'offline');
  await shoot(topbar, '11-indicator-offline');
  await page.screenshot({ path: shotPath('11-offline-page', project) });
  await page.context().setOffline(false);
  await expectSynced(page);
  await shoot(topbar, '09-indicator-synced');

  // A conflict on B: A changes the note first, B changes it offline.
  await syncCall(b.page, 'syncNow');
  await b.context.setOffline(true);
  const base = (await engineCall<{ text: string }>(b.page, 'readNote', target, { record: false }))
    .text;
  await engineCall(page, 'saveNote', target, `${base}\nThe first device's ending.\n`, {});
  await syncCall(page, 'syncNow');
  await engineCall(b.page, 'saveNote', target, `${base}\nThe second device's ending.\n`, {});
  await b.context.setOffline(false);
  await expect(b.page.getByTestId('sync-indicator')).toHaveAttribute('data-state', 'attention', {
    timeout: 30_000,
  });
  await clientGo(b.page, '/hot');
  await expect(b.page.getByTestId('conflicts-notice')).toBeVisible();
  await b.page.screenshot({ path: shotPath('12-attention-conflict', project) });
  await clientGo(b.page, '/more#sync-conflicts');
  await expect(b.page.getByTestId('sync-conflict')).toBeVisible();
  await b.page.getByTestId('sync-conflicts').scrollIntoViewIfNeeded();
  await b.page.screenshot({ path: shotPath('13-conflict-list', project) });
  await section(b.page).screenshot({ path: shotPath('13-conflict-section', project) });
  await b.context.close();

  // A blog post waiting to sync.
  // (Pages load their code on first visit; tests block the service worker
  // that caches it, so open the page before going offline.)
  const post = 'blog/2026/2026-11-20-a-small-post.md';
  await engineCall(page, 'saveNote', post, '# A small post\n\nInvented.\n', {});
  await clientGo(page, `/note/${post}`);
  await expect(page.getByTestId('publish-badge')).toHaveText('Draft');
  await page.context().setOffline(true);
  await page.getByRole('button', { name: /Publish…/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByTestId('publish-badge')).toHaveText('Published, waiting to sync');
  await page.screenshot({ path: shotPath('14-blog-waiting', project) });
  await page.context().setOffline(false);
  await expect(page.getByTestId('publish-badge')).toHaveText('Published', { timeout: 30_000 });
});
