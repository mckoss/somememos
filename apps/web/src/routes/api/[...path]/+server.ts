// Every /api route goes to the server's API (packages/server/src/http.ts),
// which does its own routing, access checks and validation. Pages render in
// the browser (src/routes/+layout.ts); this endpoint runs on the server.

import type { RequestHandler } from '@sveltejs/kit';
import { serverApp } from '#lib/server/app.ts';

const handler: RequestHandler = ({ request, getClientAddress }) => {
  let clientAddress = 'unknown';
  try {
    clientAddress = getClientAddress();
  } catch {
    // Not every adapter knows the address; failed attempts are then limited together.
  }
  return serverApp().handle(request, { clientAddress });
};

export const GET = handler;
export const HEAD = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
