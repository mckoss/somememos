// Server start-up: validate the configuration and migrate the database once,
// logging clear errors. The app serves the offline web app either way; the
// API answers 503 when there is no database or the configuration is invalid.

import { building } from '$app/env';
import type { Handle, ServerInit } from '@sveltejs/kit/hooks';
import { serverApp } from '#lib/server/app.ts';
import { clientAddressOf, robotsTxt } from '#lib/server/blog/handler.ts';

export const init: ServerInit = async () => {
  // The build renders the offline shell through the server; it needs no database.
  if (building) return;
  await serverApp().start();
};

// robots.txt lets crawlers read the public blogs and nothing else (#lib/server/blog).
export const handle: Handle = ({ event, resolve }) =>
  event.url.pathname === '/robots.txt' && ['GET', 'HEAD'].includes(event.request.method)
    ? robotsTxt(event.request, clientAddressOf(event))
    : resolve(event);
