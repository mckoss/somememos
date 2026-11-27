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

/**
 * The app's content security policy (`csp` below). SvelteKit adds the hashes of the inline
 * scripts it writes into each page. The brain worker and SQLite's
 * WebAssembly need `worker-src 'self'` and `'wasm-unsafe-eval'`; images in
 * notes may come from any https address, as they always could. Notes are
 * rendered with DOMPurify (#lib/ui/markdown.ts); this is the second line.
 * `frame-ancestors` only works as a header, which SvelteKit sends for pages
 * it renders; hooks.server.ts adds `X-Frame-Options` as well. The public
 * blog sets its own, stricter policy (#lib/server/blog/pages.ts).
 */
export default defineConfig({
  // SvelteKit 3 takes its configuration here; there is no svelte.config.js.
  plugins: [
    sveltekit({
      adapter: withOfflineShell(adapterNode()),
      csp: {
        mode: 'hash',
        directives: {
          'default-src': ['self'],
          'script-src': ['self', 'wasm-unsafe-eval'],
          'style-src': ['self', 'unsafe-inline'],
          'img-src': ['self', 'data:', 'blob:', 'https:'],
          'font-src': ['self'],
          'connect-src': ['self'],
          'worker-src': ['self'],
          'manifest-src': ['self'],
          'object-src': ['none'],
          'base-uri': ['self'],
          'form-action': ['self'],
          'frame-ancestors': ['none'],
        },
      },
    }),
  ],
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
