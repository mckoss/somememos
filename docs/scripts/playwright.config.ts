import { defineConfig } from '@playwright/test';

// The screenshots in docs/web-app.md, taken from the built app on invented
// notes. Not part of `npm run check`. Start a server with a database first (see
// docs/server.md, "Running it locally"), then from the repo root:
//
//   DOCS_BASE_URL=http://localhost:3000 DOCS_TOKEN=<token> \
//     npx playwright test -c docs/scripts/playwright.config.ts --trace off
//   docs/scripts/optimize-images.sh
//
// Raw PNGs go to node_modules/.cache/somememos-docs/raw; the optimize script
// writes the ones the docs use to docs/images/.

export default defineConfig({
  testDir: '.',
  testMatch: 'screenshots.spec.ts',
  outputDir: '../../node_modules/.cache/somememos-docs/results',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.DOCS_BASE_URL ?? 'http://localhost:3000',
    serviceWorkers: 'block',
    deviceScaleFactor: 1,
  },
  projects: [
    {
      name: 'phone',
      use: {
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      },
    },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 800 } } },
  ],
});
