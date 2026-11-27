// Browser tests of the on-device brain (apps/web/e2e-storage): the SQLite
// driver and the shared conformance suites on OPFS, persistence, offline
// use, several tabs, a large import, the in-memory fallback and timings.
// Separate from the UI's end-to-end tests (playwright.config.ts, e2e/).
//
//   npx playwright test -c apps/web/playwright.storage.config.ts --trace off
//
// It serves the production build (`vite build`, then adapter-node's server)
// and a test harness page (e2e-storage/harness) on two free ports. Set
// STORAGE_SKIP_BUILD=1 to serve an existing build without rebuilding.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const webDir = fileURLToPath(new URL('.', import.meta.url));

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

// Chosen once by the runner; its worker processes inherit them.
process.env.STORAGE_APP_PORT ??= freePort();
process.env.STORAGE_HARNESS_PORT ??= freePort();
const appPort = process.env.STORAGE_APP_PORT;
const harnessPort = process.env.STORAGE_HARNESS_PORT;
const skipBuild = process.env.STORAGE_SKIP_BUILD === '1';

export default defineConfig({
  testDir: './e2e-storage',
  testMatch: '**/*.spec.ts',
  outputDir: './e2e-storage/dist/test-results',
  // One at a time, so the reported timings aren't skewed by parallel tests.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${appPort}`,
    trace: 'off',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    // The phone project runs only the tests tagged @phone.
    { name: 'phone', use: { ...devices['Pixel 7'] }, grep: /@phone/ },
  ],
  webServer: [
    {
      command: skipBuild ? 'node build' : 'npx vite build && node build',
      cwd: webDir,
      url: `http://127.0.0.1:${appPort}/manifest.webmanifest`,
      env: { PORT: appPort, HOST: '127.0.0.1' },
      reuseExistingServer: false,
      timeout: 300_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: `npx vite build -c e2e-storage/harness/vite.config.ts && npx vite preview -c e2e-storage/harness/vite.config.ts --port ${harnessPort} --bypass-lock`,
      cwd: webDir,
      url: `http://127.0.0.1:${harnessPort}/`,
      reuseExistingServer: false,
      timeout: 300_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
