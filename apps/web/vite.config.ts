import { copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import adapterNode from '@sveltejs/adapter-node';
import type { Adapter } from '@sveltejs/kit';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { define } from './app-version.ts';

/**
 * The page the service worker serves for any navigation while offline. It
 * is SvelteKit's single-page-app fallback: an HTML shell with no server
 * rendering that starts the client router, which then renders whatever route
 * the URL names. The data all lives on the device, so no route needs the
 * server to render.
 */
export const OFFLINE_SHELL = 'offline-shell.html';

/**
 * adapter-node, plus the offline shell among the client files it serves
 * (it builds its table of static files from what `writeClient` returns, so
 * the shell is added there).
 */
function withOfflineShell(inner: Adapter): Adapter {
  return {
    ...inner,
    async adapt(builder) {
      const shell = builder.getBuildDirectory(`somememos/${OFFLINE_SHELL}`);
      rmSync(shell, { force: true });
      await builder.generateFallback(shell);
      const writeClient = builder.writeClient.bind(builder);
      builder.writeClient = (dest: string) => {
        const files = writeClient(dest);
        copyFileSync(shell, join(dest, OFFLINE_SHELL));
        return [...files, OFFLINE_SHELL];
      };
      await inner.adapt(builder);
    },
  };
}

export default defineConfig({
  // SvelteKit 3 takes its configuration here; there is no svelte.config.js.
  plugins: [sveltekit({ adapter: withOfflineShell(adapterNode()) })],
  define,
  // The brain worker (src/lib/brain/worker.ts) is an ES module worker: it
  // imports SQLite WebAssembly, which loads its .wasm with
  // `new URL('sqlite3.wasm', import.meta.url)`. Vite emits that file as a
  // hashed asset under _app/immutable/, served as application/wasm with a
  // year-long immutable cache, and the service worker precaches it.
  worker: { format: 'es' },
  // Pre-bundling would move the module away from its .wasm file in dev.
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
});
