// Builds the storage test harness: a page and probe workers for the SAH
// pool's exclusive-access test (../sah-pool.spec.ts), on the browser SQLite
// driver on OPFS. Test-only; never part of the app build. (The conformance
// suites run under Vitest's browser mode: ../../vitest.storage.config.ts.)
//
//   vite build -c e2e-storage/harness/vite.config.ts     (from apps/web)
//   vite preview -c e2e-storage/harness/vite.config.ts --port <port>

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Workspace packages resolve to their TypeScript source.
const conditions = ['source', 'module', 'browser', 'development|production'];

export default defineConfig({
  root: here('.'),
  base: './',
  resolve: { conditions },
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
