// Server start-up: validate the configuration and migrate the database once,
// logging clear errors. The app serves the offline web app either way; the
// API answers 503 when there is no database or the configuration is invalid.

import { building } from '$app/env';
import type { ServerInit } from '@sveltejs/kit/hooks';
import { serverApp } from '#lib/server/app.ts';

export const init: ServerInit = async () => {
  // The build renders the offline shell through the server; it needs no database.
  if (building) return;
  await serverApp().start();
};
