// The public blog pages, rendered on the server (#lib/server/blog/handler.ts).
// An endpoint, not a page: the app's `ssr = false` (routes/+layout.ts) does
// not apply, and no client-side code is sent. The handler decides trailing
// slashes itself, so the index lives at /blog/{slug}/ and posts have none.

import type { RequestHandler } from '@sveltejs/kit';
import { clientAddressOf, handleBlog } from '#lib/server/blog/handler.ts';

export const trailingSlash = 'ignore';
export const prerender = false;

export const GET: RequestHandler = (event) => handleBlog(event.request, clientAddressOf(event));
