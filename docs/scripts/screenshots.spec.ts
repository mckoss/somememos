// Takes the screenshots for docs/web-app.md (see playwright.config.ts here).
// Everything shown is the invented brain from @somememos/core/testing/brain.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { clientGo, engineCall, nav, testBrain, typeAtEnd } from '../../apps/web/e2e/fixtures.ts';

const RAW = join(import.meta.dirname, '../../node_modules/.cache/somememos-docs/raw');
const TOKEN = process.env.DOCS_TOKEN ?? '';

async function shot(page: Page, name: string, project: string): Promise<void> {
  mkdirSync(RAW, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(RAW, `${project}-${name}.png`), animations: 'disabled' });
}

test('documentation screenshots', async ({ page }, info) => {
  const project = info.project.name;
  const phone = project === 'phone';
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });

  // Import, stopping at the review step to show the folder roles.
  const brain = testBrain();
  await page.goto('/more');
  await page.waitForFunction(() => 'somememos' in globalThis);
  await page.getByTestId('import-folder').setInputFiles(brain.dir);
  await expect(page.getByText(/files? found/)).toBeVisible();
  const importSection = page.locator('#import');
  await importSection.getByLabel(/Excluded/).fill('private/');
  await importSection.getByLabel(/^Blog/).fill('blog/');
  await importSection.getByLabel(/Excluded/).scrollIntoViewIfNeeded();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  if (phone) await shot(page, 'import-roles', project);
  await importSection.getByRole('button', { name: /^Import \d+ notes/ }).click();
  await expect(importSection.getByText(/^Imported \d+ notes/)).toBeVisible();
  await page.getByTestId('import-log').setInputFiles(brain.eventsFile);
  await expect(page.getByTestId('log-message')).toContainText('Added');

  await nav(page, 'Hot');
  await expect(page.getByRole('article').first()).toBeVisible();
  if (phone) await shot(page, 'hot', project);

  await nav(page, 'Search');
  await page.getByRole('searchbox').fill('hive');
  await expect(page.getByRole('article').first()).toBeVisible();
  await page.waitForTimeout(1000); // let the search settle, so the card isn't re-rendered
  await page.getByText('Why this rank').first().click();
  await expect(page.locator('details.why[open]').first()).toBeVisible();
  await page.locator('details.why[open]').first().scrollIntoViewIfNeeded();
  if (!phone) await shot(page, 'search-breakdown', project);

  const hot = await engineCall<{ results: { path: string | null }[] }>(page, 'list', 'hot', {});
  const path = hot.results.find((r) => r.path)!.path!;
  await clientGo(page, `/note/${path}`);
  await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
  if (phone) await shot(page, 'note', project);

  await page.getByRole('link', { name: 'Edit' }).click();
  await expect(page.locator('.cm-content')).toBeVisible();
  await typeAtEnd(page, '\n\n## Next steps\n\n- [ ] order a second [[smoker-reading]] kit\n');
  if (!phone) await shot(page, 'editor', project);
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Done' }).click();

  // A blog post, at the publish confirmation.
  await nav(page, 'New');
  await page.getByLabel(/Blog post/).check();
  await page.getByLabel('Title').fill('What the bees taught me');
  await page.getByRole('button', { name: 'Start writing' }).click();
  await typeAtEnd(page, 'A short post about the first season with the hive.');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('Created.')).toBeVisible();
  await page.getByRole('button', { name: 'Publish…' }).click();
  if (!phone) await shot(page, 'publish', project);
  await page.getByRole('dialog').getByRole('button', { name: 'Publish', exact: true }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Done' }).click();

  // Connect to the server as a new brain, and show the sync settings.
  if (phone && TOKEN) {
    await clientGo(page, '/more#sync');
    const section = page.locator('#sync');
    await section.getByTestId('sync-token').fill(TOKEN);
    await section.getByRole('button', { name: 'Continue' }).click();
    await section.getByRole('radio', { name: 'A new brain on the server' }).check();
    await section.getByTestId('sync-new-name').fill(process.env.DOCS_BRAIN ?? 'garden');
    await section.getByRole('button', { name: 'Next' }).click();
    await expect(section.getByTestId('sync-plan')).toBeVisible();
    await section.scrollIntoViewIfNeeded();
    await shot(page, 'sync-plan', project);
    await section.getByTestId('sync-confirm').click();
    await expect(page.getByTestId('sync-indicator')).toHaveAttribute('data-state', 'synced', {
      timeout: 60_000,
    });
    await section.scrollIntoViewIfNeeded();
    await shot(page, 'sync-connected', project);
  }
});
