import { defineConfig } from '@playwright/test';

// End-to-end tests against the built app (`npm run build -w @somememos/web`
// first), at a phone size with touch and at a desktop size. Run from the repo
// root:
//
//   npx playwright test -c apps/web/playwright.config.ts --trace off
//
// Screenshots of the main screens go to $SCREENSHOT_DIR (default: under
// node_modules/.cache, which git ignores).

const PORT = Number(process.env.E2E_PORT ?? 4317);

export default defineConfig({
  testDir: 'e2e',
  outputDir: '../../node_modules/.cache/somememos-e2e/results',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  reporter: [['list']],
  webServer: {
    command: 'node build',
    cwd: import.meta.dirname,
    port: PORT,
    env: { PORT: String(PORT), HOST: '127.0.0.1' },
    reuseExistingServer: false,
    timeout: 30_000,
  },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // The service worker caches the app; tests always want the build under test.
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
