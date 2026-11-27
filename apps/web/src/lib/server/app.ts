// The server's API for this process (packages/server), created once from the
// environment: DATABASE_URL, SOMEMEMOS_DATA_DIR, SOMEMEMOS_TOKEN, PORT. Read
// directly from `process.env` (not `$env`), so tests can import this module
// without the SvelteKit plugin. Server-only ($lib/server).

import { createAppFromEnv, type App } from '@somememos/server';

let app: App | undefined;

/** The process's API app, created on first use. */
export function serverApp(): App {
  app ??= createAppFromEnv(process.env);
  return app;
}

/** Forgets the app (tests that change the environment). */
export async function resetServerApp(): Promise<void> {
  const current = app;
  app = undefined;
  await current?.close();
}
