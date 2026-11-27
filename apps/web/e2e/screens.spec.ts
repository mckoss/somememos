// Screenshots of the main screens in light and dark, for review (not compared
// against a baseline). They go to $SCREENSHOT_DIR, and the spec runs only when
// that is set: it exists to produce images, and the behaviour it passes
// through is asserted by app.spec.ts.
//
//   SCREENSHOT_DIR=/some/dir npx playwright test -c apps/web/playwright.config.ts screens
import { expect, test } from '@playwright/test';
import { clientGo, engineCall, importBrain, nav, screenshotPath, typeAtEnd } from './fixtures.ts';

test.skip(!process.env.SCREENSHOT_DIR, 'screenshots only: set SCREENSHOT_DIR to take them');

test('screenshots of the main screens', async ({ page }, info) => {
  test.setTimeout(120_000);
  /** One screenshot in each colour scheme, ending in light. */
  const shot = async (name: string, fullPage = false) => {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await page.waitForTimeout(200);
      await page.screenshot({
        path: screenshotPath(`${name}-${scheme}`, info.project.name),
        fullPage,
      });
    }
    await page.emulateMedia({ colorScheme: 'light' });
  };
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });

  await page.goto('/');
  await expect(page.getByText('Your brain is empty')).toBeVisible();
  await shot('01-empty');

  await importBrain(page, { blog: true });
  await page.locator('#import').scrollIntoViewIfNeeded();
  await shot('02-more-imported');

  await nav(page, 'Search');
  await page.getByRole('searchbox').fill('hive');
  await expect(page.getByRole('article').first()).toBeVisible();
  await shot('03-search');
  await page.getByText('Why this rank').first().click();
  await page.getByRole('region', { name: 'Activity' }).first().scrollIntoViewIfNeeded();
  await shot('04-search-breakdown');

  await nav(page, 'Hot');
  await expect(page.getByRole('article').first()).toBeVisible();
  await shot('05-hot');
  await nav(page, 'Trending');
  await expect(page.getByRole('article').first()).toBeVisible();
  await page.getByText('Why this rank').first().click();
  await shot('06-trending-breakdown');
  await nav(page, 'Neglected');
  await expect(page.getByRole('article').first()).toBeVisible();
  await shot('07-neglected');
  await clientGo(page, '/dangling');
  await expect(page.getByRole('heading', { level: 1, name: 'Not written yet' })).toBeVisible();
  await shot('08-not-written-yet');

  const hot = await engineCall<{ results: { path: string | null }[] }>(page, 'list', 'hot', {});
  const path = hot.results.find((r) => r.path)!.path!;
  await clientGo(page, `/note/${path}`);
  await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
  await shot('09-note');

  await page.getByRole('link', { name: 'Edit' }).click();
  await expect(page.locator('.cm-content')).toBeVisible();
  await typeAtEnd(page, '\n\n## Next steps\n\n- [ ] check the [[');
  await expect(page.locator('.cm-tooltip-autocomplete')).toBeVisible();
  await shot('10-editor-autocomplete');
  await page.keyboard.press('Escape');
  await page.keyboard.type('Compost Tea]] idea\n- [x] **done**');
  const preview = page.getByRole('button', { name: 'Preview' });
  if (await preview.isVisible()) {
    await preview.click();
    await shot('11-editor-preview');
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
  } else {
    await shot('11-editor-preview');
  }

  await engineCall(page, 'saveNote', path, 'Someone else changed this.\n', {});
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await shot('12-conflict');
  await page.getByRole('button', { name: 'Keep mine' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();

  await nav(page, 'New');
  await page.getByLabel(/Blog post/).check();
  await page.getByLabel('Title').fill('Why memos beat folders');
  await shot('13-new');
  await page.getByRole('button', { name: 'Start writing' }).click();
  await typeAtEnd(page, 'Draft post body.');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('Created.')).toBeVisible();
  await page.getByRole('button', { name: 'Publish…' }).click();
  await shot('14-publish-confirm');
  await page.getByRole('dialog').getByRole('button', { name: 'Publish', exact: true }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByTestId('publish-badge')).toHaveText('Published');
  await shot('15-blog-note');

  await nav(page, 'More');
  await expect(page.getByRole('heading', { level: 1, name: 'More' })).toBeVisible();
  await shot('16-more');
  await page.getByRole('heading', { name: 'Brain status' }).scrollIntoViewIfNeeded();
  await shot('17-more-status');
});
