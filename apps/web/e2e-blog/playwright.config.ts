import { defineConfig } from '@playwright/test';

// The public blog pages against the built app (`npm run build -w
// @somememos/web` first) with a real Postgres: they need a database, so
// without SOMEMEMOS_TEST_DATABASE_URL every test is skipped. Run from the
// repo root:
//
//   eval "$(packages/pg-store/scripts/dev-postgres.sh)"
//   npx playwright test -c apps/web/e2e-blog/playwright.config.ts --trace off
//
// Screenshots are taken only when $BLOG_SCREENSHOT_DIR is set.

const PORT = Number(process.env.E2E_BLOG_PORT ?? 4319);
export const E2E_TOKEN = 'blog-e2e-token-0123456789abcdefghij';
const database = process.env.SOMEMEMOS_TEST_DATABASE_URL;

export default defineConfig({
  testDir: '.',
  outputDir: '../../../node_modules/.cache/somememos-e2e-blog/results',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  reporter: [['list']],
  ...(database
    ? {
        globalSetup: './global-setup.ts',
        webServer: {
          command: 'node e2e-blog/server.mjs',
          cwd: `${import.meta.dirname}/..`,
          port: PORT,
          env: {
            PORT: String(PORT),
            HOST: '127.0.0.1',
            // Absolute addresses (canonical links, the feed) are built from it.
            ORIGIN: `http://127.0.0.1:${PORT}`,
            SOMEMEMOS_TEST_DATABASE_URL: database,
            SOMEMEMOS_TOKEN: E2E_TOKEN,
          },
          reuseExistingServer: false,
          timeout: 30_000,
        },
      }
    : {}),
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
      use: { browserName: 'chromium', viewport: { width: 1280, height: 800 } },
    },
  ],
});
