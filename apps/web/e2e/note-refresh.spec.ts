// The note page follows the brain: it reloads after every change (a save in
// another tab, a sync bringing notes), and what it shows must follow too. A
// note that wasn't there when the page opened appears once it arrives, and a
// note deleted elsewhere turns into "No note here yet".
import { expect, test } from '@playwright/test';
import { clientGo, engineCall } from './fixtures.ts';

test('the note page shows a note that arrives after it opened, and one that goes', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await page.waitForFunction(() => 'somememos' in globalThis);
  await clientGo(page, '/note/memos/arriving.md');
  await expect(page.getByRole('heading', { name: 'No note here yet' })).toBeVisible();

  // Another tab creates it (as a sync would).
  const other = await context.newPage();
  await other.goto('/');
  await other.waitForFunction(() => 'somememos' in globalThis);
  await engineCall(other, 'saveNote', 'memos/arriving.md', '# Arriving\n\nInvented.\n', {});
  await expect(page.locator('.note-head h1')).toHaveText('Arriving');
  await expect(page.getByRole('heading', { name: 'No note here yet' })).toHaveCount(0);

  await engineCall(other, 'deleteNote', 'memos/arriving.md', {});
  await expect(page.getByRole('heading', { name: 'No note here yet' })).toBeVisible();
  await expect(page.locator('.note-head')).toHaveCount(0);
});
