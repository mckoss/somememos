// Builds the storage test harness: a page and a worker that run the shared
// conformance suites (and the driver tests) in a real browser against the
// browser SQLite driver on OPFS. Test-only; never part of the app build.
//
//   vite build -c e2e-storage/harness/vite.config.ts     (from apps/web)
//   vite preview -c e2e-storage/harness/vite.config.ts --port <port>

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Workspace packages resolve to their TypeScript source, where the
// test-only entry points (`@somememos/core/testing/*`) live.
const conditions = ['source', 'module', 'browser', 'development|production'];

export default defineConfig({
  root: here('.'),
  base: './',
  resolve: {
    conditions,
    alias: { vitest: here('./vitest-shim.ts') },
  },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  build: {
    outDir: here('../dist/harness'),
    emptyOutDir: true,
    target: 'es2022',
    minify: false,
    sourcemap: true,
  },
  preview: { host: '127.0.0.1', strictPort: true },
});
