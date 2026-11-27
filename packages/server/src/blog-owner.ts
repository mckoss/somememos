// What the blog's owner needs besides its settings (./blog-settings.ts): a
// live check of a slug while typing, and the public address a post in the
// blog folder has (`GET /api/brains/{brain}/blog/slug` and `…/blog/address`).
// Owner-only, like the settings; nothing here is public.

import { markdown, storage } from '@somememos/core';
import type pg from 'pg';
import { postKey } from './blog.js';
import { blogSlugProblem } from './blog-settings.js';

export interface SlugCheck {
  readonly slug: string;
  readonly available: boolean;
  /** Why it can't be used ('taken' when another blog has it), or null. */
  readonly problem: string | null;
  readonly taken: boolean;
}

/** Whether `slug` could name `brainId`'s blog: valid, not reserved, not another blog's. */
export async function checkBlogSlug(
  pool: pg.Pool,
  brainId: string,
  slug: string,
): Promise<SlugCheck> {
  const problem = blogSlugProblem(slug);
  if (problem) return { slug, available: false, problem, taken: false };
  const { rows } = await pool.query<{ brain_id: string }>(
    'SELECT brain_id FROM server_blogs WHERE slug = $1',
    [slug],
  );
  const taken = rows.some((r) => r.brain_id !== brainId);
  return {
    slug,
    available: !taken,
    problem: taken ? 'another blog on this server has that name' : null,
    taken,
  };
}

/**
 * The public address a note at `path` has (or would have, once published
 * and synced) in `brainId`'s blog: null when the blog is off, the path is
 * not in the blog folder, or its name gives it no address. The caller has
 * checked that `path` is a note path (`AddressQuery`).
 */
export async function postAddress(
  pool: pg.Pool,
  brainId: string,
  path: string,
): Promise<{ url: string | null }> {
  const { rows } = await pool.query<{ slug: string | null; enabled: boolean; config: string }>(
    `SELECT b.slug, b.enabled, s.config FROM server_brains s
     LEFT JOIN server_blogs b USING (brain_id) WHERE s.brain_id = $1`,
    [brainId],
  );
  const row = rows[0];
  if (!row || !row.enabled || !row.slug) return { url: null };
  const roles = storage.parseBrainConfig({ ...JSON.parse(row.config), clientId: 'server' }).roles;
  const role = markdown.createRoleClassifier(roles).classify(path);
  if (role?.role !== 'blog') return { url: null };
  const key = postKey(path, role.date ?? null);
  return { url: key ? `/blog/${row.slug}/${key.key}` : null };
}
