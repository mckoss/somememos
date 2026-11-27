import { execFileSync } from 'node:child_process';
import { defineConfig } from '@playwright/test';

// End-to-end tests of sync (e2e/sync*.spec.ts) against the real built server
// with a real Postgres, set up by e2e/sync-setup.ts. Two browser contexts act
// as two devices. Build first (`npm run build`). Run from the repo root:
//
//   npx playwright test -c apps/web/playwright.sync.config.ts --trace off
//
// Postgres comes from SOMEMEMOS_TEST_DATABASE_URL (a fresh database is
// created in it) or, without it, a throwaway cluster from
// packages/pg-store/scripts/dev-postgres.sh. With neither, the suite skips.
// Screenshots go to $SYNC_SCREENSHOT_DIR (default: under node_modules/.cache).

function freePort(): string {
  return execFileSync(
    process.execPath,
    [
      '-e',
      "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})",
    ],
    { encoding: 'utf8' },
  );
}

// Chosen once by the runner; its worker processes inherit it.
process.env.SYNC_E2E_PORT ??= freePort();
const PORT = Number(process.env.SYNC_E2E_PORT);

export default defineConfig({
  testDir: 'e2e',
  testMatch: 'sync*.spec.ts',
  outputDir: '../../node_modules/.cache/somememos-e2e/sync-results',
  globalSetup: './e2e/sync-setup.ts',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    serviceWorkers: 'block',
    deviceScaleFactor: 2,
  },
  projects: [
    {
      name: 'phone',
      use: {
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'desktop',
      use: {
        browserName: 'chromium',
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
});
