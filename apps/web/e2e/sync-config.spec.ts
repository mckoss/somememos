// The shared config (folder roles) as one synced thing, between two devices
// (two browser contexts) through the real server with a real Postgres
// (playwright.sync.config.ts). Invented content only.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  TEST_TOKEN,
  baseURL,
  clientGo,
  engineCall,
  expectSynced,
  skipWithoutServer,
  syncCall,
  twoDevices,
} from './sync-fixtures.ts';

skipWithoutServer();

const SHOTS =
  process.env.GAPS_SCREENSHOT_DIR ??
  join(import.meta.dirname, '../../../node_modules/.cache/somememos-e2e/screens-gaps');
mkdirSync(SHOTS, { recursive: true });

const titles = (page: Page) =>
  engineCall<{ path: string }[]>(page, 'noteTitles').then((t) => t.map((n) => n.path));

async function serverConfig(brainId: string) {
  const res = await fetch(`${baseURL()}/api/brains/${brainId}/config`, {
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { revision: number; config: { roles: Record<string, string[]> } };
}

async function serverSearch(brainId: string, q: string): Promise<string[]> {
  const res = await fetch(`${baseURL()}/api/brains/${brainId}/search?q=${q}&mode=all`, {
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
  });
  return ((await res.json()) as { results: { path: string }[] }).results.map((r) => r.path);
}

async function openRoles(page: Page) {
  await clientGo(page, '/more#roles');
  await expect(page.getByRole('heading', { name: 'Folder roles' })).toBeVisible();
  return page.locator('#roles');
}

async function setExcluded(page: Page, value: string) {
  const roles = await openRoles(page);
  await roles.getByLabel(/Excluded/).fill(value);
  await roles.getByRole('button', { name: 'Save roles' }).click();
  return roles;
}

test('roles changed on one device reach the server and the other device; a conflict asks', async ({
  browser,
  page,
}, info) => {
  const { a, b, brainId } = await twoDevices(browser, page, info, 'roles');
  await engineCall(a, 'saveNote', 'memos/hush/quiet-pond.md', '# Quiet pond\n\nheron reeds\n', {
    message: 'a note to exclude later',
  });
  await syncCall(a, 'syncNow');
  await syncCall(b.page, 'syncNow');
  expect(await titles(b.page)).toContain('memos/hush/quiet-pond.md');
  const before = (await serverConfig(brainId)).revision;

  // A excludes the folder: saved, re-indexed and sent to the server.
  const rolesA = await setExcluded(a, 'private/\nmemos/hush/');
  await expect(rolesA.getByText('Folder roles saved and sent to the server.')).toBeVisible();
  await expect(rolesA.getByTestId('roles-synced')).toContainText('shares these folder roles');
  const after = await serverConfig(brainId);
  expect(after.revision).toBe(before + 1);
  expect(after.config.roles.excluded).toEqual(['private/', 'memos/hush/']);
  expect(await serverSearch(brainId, 'heron')).toEqual([]);
  expect(await titles(a)).not.toContain('memos/hush/quiet-pond.md');

  // B takes it on its next sync, and keeps its copy of the note out of sight.
  await syncCall(b.page, 'syncNow');
  await expectSynced(b.page);
  expect(await titles(b.page)).not.toContain('memos/hush/quiet-pond.md');
  const rolesB = await openRoles(b.page);
  await expect(rolesB.getByLabel(/Excluded/)).toHaveValue('private/\nmemos/hush/');

  // Both change the roles while B is offline.
  await b.context.setOffline(true);
  await rolesB.getByLabel(/^Blog/).fill('journal/');
  await rolesB.getByRole('button', { name: 'Save roles' }).click();
  await expect(rolesB.getByText(/saved on this device/i)).toBeVisible();
  const rolesA2 = await openRoles(a);
  await rolesA2.getByLabel(/^Blog/).fill('posts/');
  await rolesA2.getByRole('button', { name: 'Save roles' }).click();
  await expect(rolesA2.getByText('Folder roles saved and sent to the server.')).toBeVisible();

  // Back online, B is told and asked; nothing was overwritten.
  await b.context.setOffline(false);
  const view = await syncCall(b.page, 'syncNow');
  expect(view.problem?.kind).toBe('config-conflict');
  await clientGo(b.page, '/more#roles');
  const conflict = b.page.getByTestId('config-conflict');
  await expect(conflict).toBeVisible();
  await expect(conflict).toContainText('journal/');
  await expect(conflict).toContainText('posts/');
  expect((await serverConfig(brainId)).config.roles.blog).toEqual(['posts/']);
  await expect(b.page.getByTestId('sync-indicator')).toHaveAttribute('data-state', 'attention');
  await conflict.scrollIntoViewIfNeeded();
  await b.page.screenshot({ path: join(SHOTS, `config-conflict-${info.project.name}.png`) });

  // B keeps the server's: both devices agree, and sync carries on.
  await conflict.getByRole('button', { name: 'Use the server’s' }).click();
  await expect(conflict).toHaveCount(0);
  await expect(b.page.locator('#roles').getByLabel(/^Blog/)).toHaveValue('posts/');
  await expectSynced(b.page);
  await b.page.locator('#roles').scrollIntoViewIfNeeded();
  await b.page.screenshot({ path: join(SHOTS, `roles-synced-${info.project.name}.png`) });
  await b.context.close();

  // A note too large to sync is named in the sync details, and stays here.
  await engineCall(a, 'saveNote', 'memos/enormous.md', `# Enormous\n\n${'z'.repeat(2_100_000)}\n`);
  await syncCall(a, 'syncNow');
  await clientGo(a, '/more#sync');
  const tooLarge = a.getByTestId('sync-too-large');
  await expect(tooLarge).toContainText('too large to sync');
  await expect(tooLarge).toContainText('memos/enormous.md');
});
