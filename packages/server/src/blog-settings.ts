// A brain's blog settings (PLAN.md section 8, "Publishing a blog"): stored in
// `server_blogs`, off by default, read and changed by the brain's owner
// through `GET`/`PUT /api/brains/{brain}/blog` (./http.ts). The public slug
// names the blog in its public addresses (`/blog/{slug}/`); it is unique
// across the server and is never the brain id.

import { sync } from '@somememos/core';
import type pg from 'pg';
import * as v from 'valibot';
import { HttpError } from './errors.js';
import { aboutTheBody, fieldCodes, parseRequest, type ErrorCode } from './requests.js';

export interface BlogSettings {
  /** True when the owner has turned the public blog on. */
  readonly enabled: boolean;
  /** The public name in the blog's addresses; null until chosen. */
  readonly slug: string | null;
  readonly title: string | null;
  readonly description: string | null;
  readonly author: string | null;
  /** The `lang` of every public page (a BCP 47 tag). */
  readonly language: string;
}

/** What the owner sees: the settings, plus the blog's public address when it is on. */
export interface BlogSettingsView extends BlogSettings {
  /** `/blog/{slug}/` when enabled, else null. */
  readonly url: string | null;
}

export const DEFAULT_BLOG_SETTINGS: BlogSettings = Object.freeze({
  enabled: false,
  slug: null,
  title: null,
  description: null,
  author: null,
  language: 'en',
});

/** A blog slug: lower-case letters, digits and single hyphens, 2 to 40 characters. */
export const BLOG_SLUG = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,39}$/;

/**
 * Slugs that are refused: names of the app's own routes and words that would
 * confuse a reader or look official.
 */
export const RESERVED_BLOG_SLUGS: ReadonlySet<string> = new Set([
  'about',
  'account',
  'admin',
  'administrator',
  'api',
  'app',
  'assets',
  'blog',
  'blogs',
  'dangling',
  'edit',
  'feed',
  'feeds',
  'health',
  'help',
  'hot',
  'icons',
  'index',
  'login',
  'logout',
  'manifest',
  'more',
  'neglected',
  'new',
  'note',
  'notes',
  'official',
  'p',
  'post',
  'posts',
  'privacy',
  'robots',
  'root',
  'rss',
  'security',
  'settings',
  'signin',
  'signup',
  'sitemap',
  'somememos',
  'static',
  'staff',
  'support',
  'system',
  'terms',
  'trending',
  'www',
]);

/** The longest title, description and author, in characters. */
export const BLOG_LIMITS = { title: 120, description: 300, author: 100 } as const;
const LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;
const LANGUAGE_MESSAGE = 'must be a language tag such as "en" or "pt-BR"';
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/;

/** Why `slug` cannot be a blog slug, or null when it can. */
export function blogSlugProblem(slug: unknown): string | null {
  if (typeof slug !== 'string') return 'slug must be a string';
  if (!BLOG_SLUG.test(slug)) {
    return 'a slug is 2 to 40 lower-case letters, digits and single hyphens, starting and ending with a letter or digit';
  }
  if (RESERVED_BLOG_SLUGS.has(slug)) return 'that slug is reserved';
  return null;
}

/** One line of plain text, trimmed; empty is null. */
const blogText = (name: keyof typeof BLOG_LIMITS) =>
  v.pipe(
    v.nullish(v.string('must be a string')),
    v.transform((value) => value?.trim() || null),
    v.check(
      (t) => t === null || t.length <= BLOG_LIMITS[name],
      `is longer than ${BLOG_LIMITS[name]} characters`,
    ),
    v.check((t) => t === null || !CONTROL.test(t), 'must be one line of plain text'),
  );

/**
 * A `PUT` body: the complete new settings (omitted optional fields become
 * empty). Its errors: `invalid-request` for the body, `invalid-slug` for the
 * slug, `invalid-argument` for the rest.
 */
export const BlogSettingsBody = sync.jsonObject(
  v.strictObject({
    enabled: v.boolean('must be true or false'),
    slug: v.pipe(
      v.nullish(v.unknown()),
      v.transform((value) => (value === '' || value === undefined ? null : value)),
      v.rawCheck<unknown>(({ dataset, addIssue }) => {
        const problem = dataset.value === null ? null : blogSlugProblem(dataset.value);
        if (problem) addIssue({ message: problem });
      }),
      v.transform((value) => value as string | null),
    ),
    title: blogText('title'),
    description: blogText('description'),
    author: blogText('author'),
    language: v.pipe(
      v.nullish(v.string(LANGUAGE_MESSAGE)),
      v.transform((value) => value || DEFAULT_BLOG_SETTINGS.language),
      v.regex(LANGUAGE, LANGUAGE_MESSAGE),
    ),
  }),
);

function blogCodes(issue: sync.Issue): ErrorCode {
  if (issue.path?.[0]?.key === 'slug' && !aboutTheBody(issue)) return [400, 'invalid-slug'];
  return fieldCodes()(issue);
}

/** Validates a `PUT` body (`BlogSettingsBody`, then: an enabled blog needs a slug and a title). */
export function parseBlogSettings(value: unknown): BlogSettings {
  const s = parseRequest(BlogSettingsBody, value, blogCodes, 'the settings');
  const settings: BlogSettings = {
    enabled: s.enabled,
    slug: s.slug ?? null,
    title: s.title ?? null,
    description: s.description ?? null,
    author: s.author ?? null,
    language: s.language ?? DEFAULT_BLOG_SETTINGS.language,
  };
  if (settings.enabled && (settings.slug === null || settings.title === null)) {
    throw new HttpError(400, 'invalid-argument', 'a blog needs a slug and a title to be turned on');
  }
  return settings;
}

interface Row {
  enabled: boolean;
  slug: string | null;
  title: string | null;
  description: string | null;
  author: string | null;
  language: string;
}

const view = (s: BlogSettings): BlogSettingsView => ({
  ...s,
  url: s.enabled && s.slug ? `/blog/${s.slug}/` : null,
});

const fromRow = (row: Row | undefined): BlogSettings =>
  row
    ? {
        enabled: row.enabled,
        slug: row.slug,
        title: row.title,
        description: row.description,
        author: row.author,
        language: row.language,
      }
    : DEFAULT_BLOG_SETTINGS;

/** The brain's blog settings (the defaults when never set). The caller has checked ownership. */
export async function readBlogSettings(pool: pg.Pool, brainId: string): Promise<BlogSettingsView> {
  const { rows } = await pool.query<Row>(
    `SELECT enabled, slug, title, description, author, language FROM server_blogs WHERE brain_id = $1`,
    [brainId],
  );
  return view(fromRow(rows[0]));
}

/** Replaces the brain's blog settings; 409 when another brain has the slug. The caller has checked ownership. */
export async function writeBlogSettings(
  pool: pg.Pool,
  brainId: string,
  settings: BlogSettings,
  now: number,
): Promise<BlogSettingsView> {
  try {
    await pool.query(
      `INSERT INTO server_blogs (brain_id, enabled, slug, title, description, author, language, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (brain_id) DO UPDATE SET
         enabled = EXCLUDED.enabled, slug = EXCLUDED.slug, title = EXCLUDED.title,
         description = EXCLUDED.description, author = EXCLUDED.author,
         language = EXCLUDED.language, updated_at = EXCLUDED.updated_at`,
      [
        brainId,
        settings.enabled,
        settings.slug,
        settings.title,
        settings.description,
        settings.author,
        settings.language,
        now,
      ],
    );
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new HttpError(409, 'slug-taken', 'another blog on this server has that slug');
    }
    throw error;
  }
  return view(settings);
}
