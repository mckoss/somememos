// The service worker: it makes the app open with no network.
//
// - On install it precaches the app: every built file (`immutable`, which
//   includes the brain worker and SQLite's .wasm), the static files
//   (manifest, icons) and the offline shell (a client-rendered page that
//   boots the router for any URL; see vite.config.ts).
// - Precached files are served from the cache. A navigation goes to the
//   network first, so an online visit gets the server's page, and falls back
//   to the offline shell when the network fails. Anything else goes to the
//   network, falling back to a cached copy if there is one.
// - Updates wait. A new version installs beside the running one and stays
//   `waiting` until the page asks it to take over (#lib/brain/updates.ts
//   posts `skip-waiting`), so an open tab never runs a mix of two versions.
//   The first version takes control at once, as there is nothing to mix with.

import { dev, version } from '$app/env';
import { assets, immutable, prerendered } from '$app/manifest';
import { self } from '$app/service-worker';

const CACHE_PREFIX = 'somememos-app-';
const CACHE = `${CACHE_PREFIX}${version}`;
const SHELL = 'offline-shell.html';

const scope = new URL(self.registration.scope);
const url = (path: string): string => new URL(path, scope).pathname;
const shellPath = url(SHELL);

// SQLite's package also ships a worker for its message API and a helper for
// its other OPFS VFS; the app uses neither, so they aren't precached.
const unused = /\/sqlite3-(worker1|opfs-async-proxy)-[^/]*\.js$/;

const precached = new Set<string>([
  ...immutable.map((f) => url(f.path)).filter((path) => !unused.test(path)),
  ...assets.map((f) => url(f.path)),
  ...prerendered.map((f) => url(f.path)),
  ...(dev ? [] : [shellPath]),
]);

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      if (dev) return;
      const cache = await caches.open(CACHE);
      await cache.addAll([...precached]);
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith(CACHE_PREFIX) && key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if ((event.data as { type?: unknown } | null)?.type === 'skip-waiting') void self.skipWaiting();
});

async function fromCache(request: Request | string): Promise<Response | undefined> {
  const cache = await caches.open(CACHE);
  return cache.match(request);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (dev || request.method !== 'GET') return;
  const target = new URL(request.url);
  if (target.origin !== scope.origin) return;
  // Public blog pages are the server's, not the app's: never cached, never the offline shell.
  if (target.pathname.startsWith(url('blog/'))) return;

  if (precached.has(target.pathname) && target.pathname !== shellPath) {
    event.respondWith((async () => (await fromCache(target.pathname)) ?? fetch(request))());
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch (error) {
          const shell = await fromCache(shellPath);
          if (shell) return shell;
          throw error;
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      try {
        return await fetch(request);
      } catch (error) {
        const cached = await fromCache(request);
        if (cached) return cached;
        throw error;
      }
    })(),
  );
});
