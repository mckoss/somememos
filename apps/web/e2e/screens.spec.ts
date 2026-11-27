// Screenshots of the main screens, for review (not compared against a baseline).
import { expect, test } from '@playwright/test';
import { clientGo, engineCall, importBrain, nav, screenshotPath, typeAtEnd } from './fixtures.ts';

test('screenshots of the main screens', async ({ page }, info) => {
  const shot = async (name: string, fullPage = false) => {
    await page.waitForTimeout(250);
    await page.screenshot({ path: screenshotPath(name, info.project.name), fullPage });
  };
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });

  await page.goto('/');
  await expect(page.getByText('Your brain is empty')).toBeVisible();
  await shot('01-empty');

  await importBrain(page, { blog: true });
  await shot('02-more-imported', true);

  await nav(page, 'Search');
  await page.getByRole('searchbox').fill('hive');
  await expect(page.getByRole('article').first()).toBeVisible();
  await shot('03-search');
  await page.getByText('Why this rank').first().click();
  await page.getByRole('article').first().scrollIntoViewIfNeeded();
  await shot('04-search-breakdown');

  await nav(page, 'Hot');
  await expect(page.getByRole('article').first()).toBeVisible();
  await shot('05-hot');
  await nav(page, 'Trending');
  await expect(page.getByRole('article').first()).toBeVisible();
  await page.getByText('Why this rank').first().click();
  await shot('06-trending-breakdown');

  const hot = await engineCall<{ results: { path: string | null }[] }>(page, 'list', 'hot', {});
  const path = hot.results.find((r) => r.path)!.path!;
  await clientGo(page, `/note/${path}`);
  await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
  await shot('07-note');

  await page.getByRole('link', { name: 'Edit' }).click();
  await expect(page.locator('.cm-content')).toBeVisible();
  await typeAtEnd(page, '\n\n## Next steps\n\n- [ ] check the [[');
  await expect(page.locator('.cm-tooltip-autocomplete')).toBeVisible();
  await shot('08-editor-autocomplete');
  await page.keyboard.press('Escape');
  await page.keyboard.type('Compost Tea]] idea\n- [x] **done**');
  const preview = page.getByRole('button', { name: 'Preview' });
  if (await preview.isVisible()) {
    await preview.click();
    await shot('09-editor-preview');
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
  } else {
    await shot('09-editor-preview');
  }

  await engineCall(page, 'saveNote', path, 'Someone else changed this.\n', {});
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await shot('10-conflict');
  await page.getByRole('button', { name: 'Keep mine' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();

  await nav(page, 'New');
  await page.getByLabel(/Blog post/).check();
  await page.getByLabel('Title').fill('Why memos beat folders');
  await shot('11-new');
  await page.getByRole('button', { name: 'Start writing' }).click();
  await typeAtEnd(page, 'Draft post body.');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('Created.')).toBeVisible();
  await page.getByRole('button', { name: 'Publish…' }).click();
  await shot('12-publish-confirm');
  await page.getByRole('dialog').getByRole('button', { name: 'Publish', exact: true }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByTestId('publish-badge')).toHaveText('Published');
  await shot('13-blog-note');

  await page.emulateMedia({ colorScheme: 'dark' });
  await nav(page, 'Search');
  await page.getByRole('searchbox').fill('frost');
  await expect(page.getByRole('article').first()).toBeVisible();
  await page.getByText('Why this rank').first().click();
  await shot('14-dark-search');
  await clientGo(page, `/edit/${path}`);
  await expect(page.locator('.cm-content')).toBeVisible();
  await shot('15-dark-editor');
  await page.getByRole('button', { name: 'Done' }).click();
  await nav(page, 'More');
  await shot('16-dark-more', true);
});
