// Unsaved editor drafts hold note text in this origin's localStorage: they
// must go once the note is saved, the draft is discarded, the note is
// deleted, or everything on the device is deleted. Invented content only.

import { expect, test, type Page } from '@playwright/test';
import { clientGo, engineCall, typeAtEnd } from './fixtures.ts';

const draftKeys = (page: Page) =>
  page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('somememos:draft:')));

async function leaveADraft(page: Page, path: string, words: string) {
  await clientGo(page, `/edit/${path}`);
  await typeAtEnd(page, words);
  await expect.poll(() => draftKeys(page)).toContain(`somememos:draft:${path}`);
}

test('drafts are removed on save, discard, delete and reset', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => 'somememos' in globalThis);
  page.on('dialog', (d) => void d.accept());
  await engineCall(page, 'saveNote', 'memos/pebble.md', '# Pebble\n\nsmooth\n');
  await engineCall(page, 'saveNote', 'memos/gravel.md', '# Gravel\n\nrough\n');

  // Saved: the draft goes.
  await leaveADraft(page, 'memos/pebble.md', ' Saved words.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await expect.poll(() => draftKeys(page)).toEqual([]);

  // Discarded after a reload restored it: the draft goes.
  await leaveADraft(page, 'memos/pebble.md', ' Discarded words.');
  await page.reload();
  await expect(page.getByText(/Restored your unsaved changes/)).toBeVisible();
  await page.getByRole('button', { name: 'Discard them' }).click();
  await expect.poll(() => draftKeys(page)).toEqual([]);

  // The note deleted: its draft goes.
  await leaveADraft(page, 'memos/gravel.md', ' Words for a doomed note.');
  await page.reload();
  await expect(page.getByText(/Restored your unsaved changes/)).toBeVisible();
  await clientGo(page, '/note/memos/gravel.md');
  await page.getByRole('button', { name: 'Delete' }).first().click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^Delete/ })
    .click();
  await expect.poll(() => draftKeys(page)).toEqual([]);

  // Everything deleted from the device: every draft goes with it.
  await leaveADraft(page, 'memos/pebble.md', ' Words before a reset.');
  await leaveADraft(page, 'memos/new-one.md', '# New one\n');
  await clientGo(page, '/more#reset');
  await page.getByRole('button', { name: 'Delete everything…' }).click();
  await page.getByLabel(/Type delete my notes to confirm/).fill('delete my notes');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete everything' }).click();
  await expect.poll(() => draftKeys(page)).toEqual([]);
});
