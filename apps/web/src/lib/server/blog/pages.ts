// The public blog's documents: the index, a post, the one "not found" page,
// the Atom feed and the sitemap. Plain HTML with one small inline stylesheet
// (light and dark by system preference, phone first), no JavaScript. Every
// value from a post or the settings goes through `escapeHtml`/`escapeXml`;
// post bodies come from ./render.ts, which builds safe HTML itself.

import { createHash } from 'node:crypto';
import type { PublicBlog, PublicPost } from '@somememos/server';
import { escapeHtml, renderPost } from './render.ts';

/** Posts on one index page. */
export const PAGE_SIZE = 10;
/** Entries in the feed. */
export const FEED_SIZE = 20;
/** Full content goes into the feed until it holds this many bytes; then summaries only. */
const FEED_CONTENT_BUDGET = 1024 * 1024;
/** URLs in a sitemap (the protocol's limit). */
const SITEMAP_LIMIT = 50_000;

export const STYLESHEET = `
:root{color-scheme:light dark;--bg:#fdfcf9;--fg:#1d1c1a;--muted:#67635c;--rule:#e4e0d8;--link:#1f5fa8;--visited:#6a4fa0;--code-bg:#f3f0ea;--accent:#b4532a}
@media (prefers-color-scheme:dark){:root{--bg:#171614;--fg:#e9e6e0;--muted:#a19c93;--rule:#34312d;--link:#8ab8f0;--visited:#bba4e6;--code-bg:#24221f;--accent:#e58a5f}}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:1.125rem/1.65 Charter,"Bitstream Charter","Sitka Text",Cambria,Georgia,serif;overflow-wrap:break-word}
.wrap{max-width:42rem;margin:0 auto;padding:0 1.25rem}
a{color:var(--link);text-underline-offset:.15em;text-decoration-thickness:.06em}
a:visited{color:var(--visited)}
a:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:2px}
.site{border-bottom:1px solid var(--rule);padding:1.5rem 0 1rem;margin-bottom:2rem}
.site-title{font:700 1.25rem/1.3 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;margin:0;letter-spacing:-.01em}
.site-title a{color:var(--fg);text-decoration:none}
.site-desc{margin:.25rem 0 0;color:var(--muted);font:1rem/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
h1,h2,h3,h4,h5,h6{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1.25;letter-spacing:-.01em;margin:2em 0 .5em}
h1{font-size:2rem;margin-top:0}
h2{font-size:1.5rem}h3{font-size:1.25rem}h4,h5,h6{font-size:1.05rem}
p,ul,ol,blockquote,.scroll,hr{margin:0 0 1.15em}
ul,ol{padding-left:1.5em}
li{margin:.25em 0}
li.task{list-style:none;margin-left:-1.25em}
blockquote{margin-left:0;padding-left:1em;border-left:3px solid var(--rule);color:var(--muted)}
hr{border:0;border-top:1px solid var(--rule);margin:2em 0}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.85em}
:not(pre)>code{background:var(--code-bg);padding:.1em .3em;border-radius:4px}
.code{background:var(--code-bg);border-radius:6px}
pre{padding:1em;margin:0;line-height:1.5;white-space:pre;width:max-content;min-width:100%}
.scroll{overflow-x:auto;max-width:100%;-webkit-overflow-scrolling:touch}
table{border-collapse:collapse;font-size:.95em;min-width:100%}
th,td{border-bottom:1px solid var(--rule);padding:.4em .75em;text-align:left;vertical-align:top}
th{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:.9em}
.align-right{text-align:right}.align-center{text-align:center}
.image-alt{color:var(--muted);font-style:italic}
.meta{color:var(--muted);font:.95rem/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;margin:0 0 2rem}
.posts{list-style:none;padding:0;margin:0}
.posts li{margin:0 0 2rem}
.posts h2{font-size:1.3rem;margin:0 0 .25rem}
.posts h2 a{color:var(--fg);text-decoration:none}
.posts h2 a:hover{text-decoration:underline}
.posts .meta{margin:0 0 .4rem}
.posts p{margin:0;color:var(--muted)}
nav.pager{display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;border-top:1px solid var(--rule);padding-top:1rem;margin:2.5rem 0 0;font:1rem/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
nav.pager a{display:inline-block;padding:.35rem 0}
nav.pager .next{margin-left:auto;text-align:right}
footer.site-foot{border-top:1px solid var(--rule);margin-top:3rem;padding:1.25rem 0 2.5rem;color:var(--muted);font:.9rem/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
footer.site-foot p{margin:0 0 .25rem}
.notice{padding-top:4rem}
@media (min-width:48rem){body{font-size:1.1875rem}.site{padding-top:2.5rem}h1{font-size:2.4rem}}
@media print{.site-foot,nav.pager{display:none}a{color:inherit}}
`
  .trim()
  .replace(/\n/g, '');

/** The `style-src` source for the stylesheet: the page's CSP allows exactly it. */
export const STYLE_HASH = `'sha256-${createHash('sha256').update(STYLESHEET, 'utf8').digest('base64')}'`;

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  `style-src ${STYLE_HASH}`,
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** The root-relative address of a blog. */
export const blogPath = (slug: string): string => `/blog/${slug}/`;

/** The root-relative address of a post. */
export function postPath(slug: string, post: PublicPost): string {
  return `/blog/${slug}/${post.key.split('/').map(encodeURIComponent).join('/')}`;
}

/** Escapes text for XML, dropping characters XML 1.0 cannot carry. */
export function escapeXml(s: string): string {
  return s
    .replace(/[^\t\n\r\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, '')
    .replace(
      /[&<>"']/g,
      (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] as string,
    );
}

const iso = (seconds: number): string =>
  new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');

function formatDate(seconds: number, language: string): string {
  const options: Intl.DateTimeFormatOptions = { dateStyle: 'long', timeZone: 'UTC' };
  try {
    return new Intl.DateTimeFormat(language, options).format(new Date(seconds * 1000));
  } catch {
    return new Intl.DateTimeFormat('en', options).format(new Date(seconds * 1000));
  }
}

interface Head {
  readonly language: string;
  readonly title: string;
  readonly description: string | null;
  readonly canonical: string | null;
  readonly feed?: { title: string; href: string };
  readonly og: Readonly<Record<string, string>>;
}

function document(head: Head, body: string): string {
  const meta = (property: string, content: string) =>
    `<meta property="${property}" content="${escapeHtml(content)}">`;
  return [
    '<!doctype html>',
    `<html lang="${escapeHtml(head.language)}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    `<title>${escapeHtml(head.title)}</title>`,
    head.description ? `<meta name="description" content="${escapeHtml(head.description)}">` : '',
    head.canonical ? `<link rel="canonical" href="${escapeHtml(head.canonical)}">` : '',
    head.feed
      ? `<link rel="alternate" type="application/atom+xml" title="${escapeHtml(head.feed.title)}" href="${escapeHtml(head.feed.href)}">`
      : '',
    ...Object.entries(head.og).map(([k, v]) => meta(k, v)),
    '<meta name="twitter:card" content="summary">',
    '<link rel="icon" href="/icons/favicon-32.png" sizes="32x32" type="image/png">',
    `<style>${STYLESHEET}</style>`,
    '</head>',
    `<body>${body}</body>`,
    '</html>',
    '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function siteHeader(blog: PublicBlog, home: boolean): string {
  const s = blog.settings;
  const title = `<a href="${blogPath(s.slug)}"${home ? ' aria-current="page"' : ''}>${escapeHtml(s.title)}</a>`;
  return `<header class="site"><div class="wrap">${home ? `<h1 class="site-title">${title}</h1>` : `<p class="site-title">${title}</p>`}${
    s.description ? `<p class="site-desc">${escapeHtml(s.description)}</p>` : ''
  }</div></header>`;
}

function siteFooter(blog: PublicBlog): string {
  const s = blog.settings;
  return `<footer class="site-foot"><div class="wrap">${
    s.author ? `<p>By ${escapeHtml(s.author)}.</p>` : ''
  }<p><a href="/blog/${s.slug}/feed.xml">Atom feed</a> · Published with somememos</p></div></footer>`;
}

function dateLine(post: PublicPost, language: string): string {
  return `<time datetime="${iso(post.published)}">${escapeHtml(formatDate(post.published, language))}</time>`;
}

/** Index page `page` (1-based), or null when there is no such page. */
export function indexPage(blog: PublicBlog, origin: string, page: number): string | null {
  const s = blog.settings;
  const posts = blog.snapshot.posts;
  const pages = Math.max(1, Math.ceil(posts.length / PAGE_SIZE));
  if (!Number.isSafeInteger(page) || page < 1 || page > pages) return null;
  const shown = posts.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const base = blogPath(s.slug);
  const pageHref = (n: number) => (n === 1 ? base : `${base}?page=${n}`);
  const items = shown
    .map(
      (p) =>
        `<li><article><h2><a href="${postPath(s.slug, p)}">${escapeHtml(p.title)}</a></h2>` +
        `<p class="meta">${dateLine(p, s.language)}</p>` +
        (p.description ? `<p>${escapeHtml(p.description)}</p>` : '') +
        '</article></li>',
    )
    .join('\n');
  const pager =
    pages > 1
      ? `<nav class="pager" aria-label="Pages">${
          page > 1
            ? `<a class="prev" href="${pageHref(page - 1)}" rel="prev">← Newer posts</a>`
            : ''
        }${page < pages ? `<a class="next" href="${pageHref(page + 1)}" rel="next">Older posts →</a>` : ''}</nav>`
      : '';
  const body =
    siteHeader(blog, true) +
    `<main class="wrap">${
      posts.length === 0
        ? '<p>Nothing has been published here yet.</p>'
        : `<ul class="posts">\n${items}\n</ul>${pager}`
    }</main>` +
    siteFooter(blog);
  const title = page === 1 ? s.title : `${s.title} (page ${page})`;
  return document(
    {
      language: s.language,
      title,
      description: s.description,
      canonical: origin + pageHref(page),
      feed: { title: s.title, href: `${origin}${base}feed.xml` },
      og: {
        'og:type': 'website',
        'og:title': title,
        'og:url': origin + pageHref(page),
        'og:site_name': s.title,
        ...(s.description ? { 'og:description': s.description } : {}),
      },
    },
    body,
  );
}

/** A post's page. */
export function postPage(blog: PublicBlog, origin: string, post: PublicPost): string {
  const s = blog.settings;
  const posts = blog.snapshot.posts;
  const at = posts.indexOf(post);
  const newer = at > 0 ? posts[at - 1] : undefined;
  const older = at >= 0 ? posts[at + 1] : undefined;
  const url = origin + postPath(s.slug, post);
  const html = renderPost({
    snapshot: blog.snapshot,
    post,
    urlOf: (p) => postPath(s.slug, p),
  });
  const pager =
    newer || older
      ? `<nav class="pager" aria-label="More posts">${
          newer
            ? `<a class="prev" href="${postPath(s.slug, newer)}" rel="prev">← ${escapeHtml(newer.title)}</a>`
            : ''
        }${older ? `<a class="next" href="${postPath(s.slug, older)}" rel="next">${escapeHtml(older.title)} →</a>` : ''}</nav>`
      : '';
  const body =
    siteHeader(blog, false) +
    `<main class="wrap"><article><h1>${escapeHtml(post.title)}</h1>` +
    `<p class="meta">${dateLine(post, s.language)}${s.author ? ` · ${escapeHtml(s.author)}` : ''}</p>` +
    `<div class="content">\n${html}</div></article>${pager}</main>` +
    siteFooter(blog);
  return document(
    {
      language: s.language,
      title: `${post.title} · ${s.title}`,
      description: post.description,
      canonical: url,
      feed: { title: s.title, href: `${origin}${blogPath(s.slug)}feed.xml` },
      og: {
        'og:type': 'article',
        'og:title': post.title,
        'og:url': url,
        'og:site_name': s.title,
        ...(post.description ? { 'og:description': post.description } : {}),
        'article:published_time': iso(post.published),
        'article:modified_time': iso(post.updated),
        ...(s.author ? { 'article:author': s.author } : {}),
      },
    },
    body,
  );
}

/** The one page for every address that has nothing public: the same bytes whatever was asked. */
export const NOT_FOUND_PAGE = document(
  {
    language: 'en',
    title: 'Not found',
    description: null,
    canonical: null,
    og: {},
  },
  '<main class="wrap notice"><h1>Not found</h1><p>There is nothing at this address.</p></main>',
);

export const TOO_MANY_PAGE = document(
  { language: 'en', title: 'Too many requests', description: null, canonical: null, og: {} },
  '<main class="wrap notice"><h1>Too many requests</h1><p>Please wait a minute and try again.</p></main>',
);

export const UNAVAILABLE_PAGE = document(
  { language: 'en', title: 'Unavailable', description: null, canonical: null, og: {} },
  '<main class="wrap notice"><h1>Temporarily unavailable</h1><p>Please try again shortly.</p></main>',
);

/** The blog's Atom feed: the newest posts, with their full content while it fits. */
export function atomFeed(blog: PublicBlog, origin: string): string {
  const s = blog.settings;
  const base = origin + blogPath(s.slug);
  const posts = blog.snapshot.posts.slice(0, FEED_SIZE);
  let budget = FEED_CONTENT_BUDGET;
  const entries = posts.map((p) => {
    const url = origin + postPath(s.slug, p);
    let content = '';
    if (budget > 0) {
      const html = renderPost({
        snapshot: blog.snapshot,
        post: p,
        urlOf: (q) => origin + postPath(s.slug, q),
      });
      budget -= Buffer.byteLength(html, 'utf8');
      if (budget >= 0) content = `<content type="html">${escapeXml(html)}</content>`;
    }
    return [
      '<entry>',
      `<title>${escapeXml(p.title)}</title>`,
      `<link rel="alternate" type="text/html" href="${escapeXml(url)}"/>`,
      `<id>${escapeXml(url)}</id>`,
      `<published>${iso(p.published)}</published>`,
      `<updated>${iso(p.updated)}</updated>`,
      p.description ? `<summary>${escapeXml(p.description)}</summary>` : '',
      content,
      '</entry>',
    ]
      .filter((l) => l !== '')
      .join('');
  });
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${escapeXml(s.language)}">`,
    `<title>${escapeXml(s.title)}</title>`,
    s.description ? `<subtitle>${escapeXml(s.description)}</subtitle>` : '',
    `<link rel="self" type="application/atom+xml" href="${escapeXml(`${base}feed.xml`)}"/>`,
    `<link rel="alternate" type="text/html" href="${escapeXml(base)}"/>`,
    `<id>${escapeXml(base)}</id>`,
    `<updated>${iso(blog.snapshot.updated || 0)}</updated>`,
    `<author><name>${escapeXml(s.author ?? s.title)}</name></author>`,
    '<generator>somememos</generator>',
    ...entries,
    '</feed>',
    '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** The blog's sitemap: its index and every published post. */
export function sitemap(blog: PublicBlog, origin: string): string {
  const s = blog.settings;
  const urls = [
    `<url><loc>${escapeXml(origin + blogPath(s.slug))}</loc>${
      blog.snapshot.updated ? `<lastmod>${iso(blog.snapshot.updated)}</lastmod>` : ''
    }</url>`,
    ...blog.snapshot.posts
      .slice(0, SITEMAP_LIMIT - 1)
      .map(
        (p) =>
          `<url><loc>${escapeXml(origin + postPath(s.slug, p))}</loc><lastmod>${iso(p.updated)}</lastmod></url>`,
      ),
  ];
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');
}
