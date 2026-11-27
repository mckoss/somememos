// Without a database the server offers no sync (playwright.config.ts runs
// the app with no DATABASE_URL). Not syncing is a normal state: no indicator,
// no nagging, and the sync settings explain why there is nothing to set up.
import { expect, test } from '@playwright/test';

test('a server without a database explains that it offers no sync', async ({ page }) => {
  await page.goto('/more');
  await page.waitForFunction(() => 'somememos' in globalThis);
  await expect(page.getByTestId('sync-indicator')).toHaveCount(0);
  const section = page.locator('#sync');
  await expect(section.getByTestId('sync-unavailable')).toContainText('doesn’t offer sync');
  await expect(section.getByTestId('sync-token')).toHaveCount(0);
  await page.goto('/');
  await expect(page.getByTestId('sync-indicator')).toHaveCount(0);
});
