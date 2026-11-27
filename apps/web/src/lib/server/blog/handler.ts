// Answers every request under /blog (routes/blog/[...path]/+server.ts) and
// /robots.txt (hooks.server.ts). Server-side only; no JavaScript reaches the
// reader.
//
//   /blog/{slug}/                          the index, newest first (?page=2, …)
//   /blog/{slug}/{YYYY}/{MM}/{DD}/{post}   a post dated by its path
//   /blog/{slug}/p/{post}                  a post with no date in its path
//   /blog/{slug}/feed.xml                  Atom
//   /blog/{slug}/sitemap.xml
//
// Which blog and which posts exist comes only from `PublicBlogs`
// (packages/server/src/blog.ts), the privacy boundary. Anything that is not a
// published post of a blog that is turned on gets `notFound()`: the same
// status, headers and bytes, decided without looking further.
//
// Pages are cached by browsers and proxies for a minute and then revalidated
// with their ETag (a hash of the page's bytes), so a post that is changed or
// unpublished stops being served within a minute.

import { createHash } from 'node:crypto';
import { BLOG_SLUG, PublicLimiter, type BlogSnapshot, type PublicBlogs } from '@somememos/server';
import { serverApp } from '../app.ts';
import {
  CONTENT_SECURITY_POLICY,
  NOT_FOUND_PAGE,
  TOO_MANY_PAGE,
  UNAVAILABLE_PAGE,
  atomFeed,
  blogPath,
  indexPage,
  postPath,
  postPage,
  sitemap,
} from './pages.ts';

export interface BlogBackend {
  readonly blogs: PublicBlogs | null;
  readonly limiter: PublicLimiter;
  readonly log?: Pick<Console, 'error'>;
}

let override: BlogBackend | undefined;
let fallback: BlogBackend | undefined;

/** Tests: serve from `backend` instead of the process's server app (undefined: back to it). */
export function setBlogBackend(backend: BlogBackend | undefined): void {
  override = backend;
}

function backend(): BlogBackend {
  if (override) return override;
  fallback ??= {
    get blogs() {
      return serverApp().blogs;
    },
    limiter: new PublicLimiter(),
  };
  return fallback;
}

/** The client's address for rate limiting; requests from an adapter that can't tell share one count. */
export function clientAddressOf(event: { getClientAddress(): string }): string {
  try {
    return event.getClientAddress();
  } catch {
    return 'unknown';
  }
}

/** How long a page may be used without asking again, in seconds. */
export const MAX_AGE = 60;

const COMMON = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
};
const HTML = 'text/html; charset=utf-8';

/** The one answer for anything with nothing public to show. */
export function notFound(): Response {
  return new Response(NOT_FOUND_PAGE, {
    status: 404,
    headers: {
      ...COMMON,
      'content-type': HTML,
      'content-security-policy': CONTENT_SECURITY_POLICY,
      'cache-control': 'no-cache',
      'x-robots-tag': 'noindex',
    },
  });
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 308,
    headers: { ...COMMON, location, 'cache-control': `public, max-age=${MAX_AGE}` },
  });
}

interface Rendered {
  readonly body: string;
  readonly etag: string;
}

/** Rendered documents, per snapshot (a new commit makes a new snapshot, so stale entries go with it). */
const rendered = new WeakMap<BlogSnapshot, Map<string, Rendered>>();
const MAX_RENDERED = 500;

function cachedRender(
  snapshot: BlogSnapshot,
  key: string,
  render: () => string | null,
): Rendered | null {
  let docs = rendered.get(snapshot);
  if (!docs) rendered.set(snapshot, (docs = new Map()));
  const hit = docs.get(key);
  if (hit) return hit;
  const body = render();
  if (body === null) return null;
  const etag = `"${createHash('sha256').update(body, 'utf8').digest('base64url').slice(0, 32)}"`;
  const doc = { body, etag };
  if (docs.size >= MAX_RENDERED) docs.clear();
  docs.set(key, doc);
  return doc;
}

function etagMatches(header: string | null, etag: string): boolean {
  if (header === null) return false;
  if (header.trim() === '*') return true;
  return header.split(',').some((t) => t.trim().replace(/^W\//, '') === etag);
}

function document(
  request: Request,
  doc: Rendered,
  type: string,
  extra: Record<string, string> = {},
): Response {
  const headers: Record<string, string> = {
    ...COMMON,
    'content-type': type,
    'cache-control': `public, max-age=${MAX_AGE}, must-revalidate`,
    etag: doc.etag,
    ...extra,
  };
  if (type === HTML) headers['content-security-policy'] = CONTENT_SECURITY_POLICY;
  if (etagMatches(request.headers.get('if-none-match'), doc.etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(doc.body, { status: 200, headers });
}

type Target =
  | { readonly kind: 'index' | 'feed' | 'sitemap'; readonly slug: string }
  | { readonly kind: 'post'; readonly slug: string; readonly key: string };

/** What an address asks for, from its shape alone; a Response for a redirect or a 404. */
function parse(url: URL): Target | Response {
  const path = url.pathname;
  if (!path.startsWith('/blog/')) return notFound();
  const segments = path.slice('/blog/'.length).split('/');
  const slug = segments[0] as string;
  if (!BLOG_SLUG.test(slug)) return notFound();
  if (segments.length === 1) return redirect(`${blogPath(slug)}${url.search}`);
  if (segments.length === 2 && segments[1] === '') return { kind: 'index', slug };
  // No trailing-slash duplicates: one address per document.
  if (segments.at(-1) === '') {
    const trimmed = path.replace(/\/+$/, '');
    return trimmed.slice(1).split('/').includes('') ? notFound() : redirect(trimmed + url.search);
  }
  const rest = segments.slice(1);
  if (rest.includes('')) return notFound();
  if (rest.length === 1 && rest[0] === 'feed.xml') return { kind: 'feed', slug };
  if (rest.length === 1 && rest[0] === 'sitemap.xml') return { kind: 'sitemap', slug };
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest.at(-1) as string);
  } catch {
    return notFound();
  }
  if (decoded.includes('/')) return notFound();
  if (rest.length === 2 && rest[0] === 'p') return { kind: 'post', slug, key: `p/${decoded}` };
  if (
    rest.length === 4 &&
    /^\d{4}$/.test(rest[0] as string) &&
    /^\d{2}$/.test(rest[1] as string) &&
    /^\d{2}$/.test(rest[2] as string)
  ) {
    return { kind: 'post', slug, key: `${rest[0]}/${rest[1]}/${rest[2]}/${decoded}` };
  }
  return notFound();
}

/** Answers a GET or HEAD under /blog/. */
export async function handleBlog(request: Request, clientAddress: string): Promise<Response> {
  const be = backend();
  const wait = be.limiter.take(clientAddress);
  if (wait > 0) {
    return new Response(TOO_MANY_PAGE, {
      status: 429,
      headers: {
        ...COMMON,
        'content-type': HTML,
        'content-security-policy': CONTENT_SECURITY_POLICY,
        'cache-control': 'no-store',
        'retry-after': String(wait),
        'x-robots-tag': 'noindex',
      },
    });
  }
  const url = new URL(request.url);
  const target = parse(url);
  if (target instanceof Response) return target;
  try {
    const blog = be.blogs ? await be.blogs.open(target.slug) : null;
    if (!blog) return notFound();
    const { snapshot, settings } = blog;
    const origin = url.origin;
    // Rendered pages depend on the settings and the origin as well as the posts.
    const variant = JSON.stringify([origin, settings]);
    switch (target.kind) {
      case 'index': {
        const raw = url.searchParams.get('page');
        if (raw === '1') return redirect(blogPath(settings.slug));
        if (raw !== null && !/^[1-9]\d{0,5}$/.test(raw)) return notFound();
        const page = raw === null ? 1 : Number(raw);
        const doc = cachedRender(snapshot, `index\0${page}\0${variant}`, () =>
          indexPage(blog, origin, page),
        );
        return doc ? document(request, doc, HTML) : notFound();
      }
      case 'feed': {
        const doc = cachedRender(snapshot, `feed\0${variant}`, () => atomFeed(blog, origin));
        return document(request, doc as Rendered, 'application/atom+xml; charset=utf-8', {
          'x-robots-tag': 'noindex',
        });
      }
      case 'sitemap': {
        const doc = cachedRender(snapshot, `sitemap\0${variant}`, () => sitemap(blog, origin));
        return document(request, doc as Rendered, 'application/xml; charset=utf-8', {
          'x-robots-tag': 'noindex',
        });
      }
      case 'post': {
        const post = snapshot.byKey(target.key);
        if (!post) return notFound();
        const canonical = postPath(settings.slug, post);
        if (url.pathname !== canonical) return redirect(canonical);
        const doc = cachedRender(snapshot, `post\0${post.key}\0${variant}`, () =>
          postPage(blog, origin, post),
        );
        return document(request, doc as Rendered, HTML);
      }
    }
  } catch (error) {
    (be.log ?? console).error(
      `somememos: a public blog request failed: ${(error as Error)?.message ?? String(error)}`,
    );
    return new Response(UNAVAILABLE_PAGE, {
      status: 503,
      headers: {
        ...COMMON,
        'content-type': HTML,
        'content-security-policy': CONTENT_SECURITY_POLICY,
        'cache-control': 'no-store',
        'retry-after': '30',
        'x-robots-tag': 'noindex',
      },
    });
  }
}

/** robots.txt: crawl the blogs (and their sitemaps), not the private app. */
export async function robotsTxt(request: Request, clientAddress: string): Promise<Response> {
  if (backend().limiter.take(clientAddress) > 0) {
    return new Response('Too many requests\n', {
      status: 429,
      headers: { ...COMMON, 'content-type': 'text/plain; charset=utf-8', 'retry-after': '60' },
    });
  }
  const origin = new URL(request.url).origin;
  let slugs: string[];
  try {
    slugs = (await backend().blogs?.enabledSlugs()) ?? [];
  } catch {
    slugs = [];
  }
  const body = [
    'User-agent: *',
    'Allow: /blog/',
    'Disallow: /',
    '',
    ...slugs.map((s) => `Sitemap: ${origin}${blogPath(s)}sitemap.xml`),
    '',
  ].join('\n');
  return new Response(body, {
    status: 200,
    headers: {
      ...COMMON,
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': `public, max-age=300`,
    },
  });
}
