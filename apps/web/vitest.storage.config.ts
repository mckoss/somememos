// The shared conformance suites and the driver tests in a real browser, on
// the SQLite WebAssembly driver on OPFS: Vitest's browser mode, with
// Playwright's Chromium (e2e-storage/conformance). The suites themselves run
// in a dedicated worker; see e2e-storage/conformance/opfs.test.ts.
//
//   npx vitest run -c apps/web/vitest.storage.config.ts
//
// Not part of `npm test` (the root's projects use apps/web/vitest.config.ts);
// `npm run e2e` runs it. STORAGE_VITEST_PORT sets the browser server's port.

import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Workspace packages resolve to their TypeScript source, where the
  // test-only entry points (`@somememos/core/testing/*`) live.
  resolve: { conditions: ['source', 'module', 'browser', 'development|production'] },
  // fast-check is found only once the worker loads the suites; listing it
  // here keeps Vite from reloading the page to optimize it mid-run.
  optimizeDeps: { include: ['fast-check'], exclude: ['@sqlite.org/sqlite-wasm'] },
  worker: { format: 'es' },
  test: {
    name: 'storage-browser',
    root: import.meta.dirname,
    include: ['e2e-storage/conformance/**/*.test.ts'],
    // The worker's runner gets this config too: the same per-test timeout as before.
    testTimeout: 60_000,
    api: { port: Number(process.env.STORAGE_VITEST_PORT ?? 63315), host: '127.0.0.1' },
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: 'chromium' }],
      // The page is blank (the suites run in the worker): a screenshot shows nothing.
      screenshotFailures: false,
    },
  },
});
