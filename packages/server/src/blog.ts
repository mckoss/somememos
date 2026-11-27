// The public side of a brain's blog (PLAN.md section 8, "Publishing a blog"),
// and the privacy boundary around it. Everything an anonymous request can
// learn about a brain comes through `PublicBlogs.open`, and this file is the
// one place that decides what that is:
//
// - A blog is found by its public slug, only when its owner turned it on
//   (`server_blogs`, ./blog-settings.ts). The brain id never leaves this file.
// - Its posts are read from the brain's git repository **at the commit the
//   database has recorded** (`server_brains.git_head`), never from the
//   working tree, and without the brain's lock: git objects of a recorded
//   commit never change, so a public request can't see half a change, can't
//   block the owner's writes, and isn't blocked by them.
// - Of the files in that commit, only those whose folder role is `blog` are
//   read, and only those whose front matter says `published: true`
//   (`markdown.isPublished`) are kept. A `BlogSnapshot` holds those posts and
//   nothing else: no path, no draft, no other note. Whatever renders a page
//   gets a snapshot, so it cannot reach anything private.
// - A `[[link]]` resolves only among the snapshot's published posts
//   (`BlogSnapshot.link`), with core's resolution rules. Whether a private
//   note or a draft of that name exists therefore cannot change a public
//   page at all.
// - Nothing here touches the engine: no events are logged and no score
//   changes.
//
// A snapshot is built once per recorded commit and cached, so a new commit
// (a post synced, published, unpublished, renamed or deleted) shows on the
// very next request, and an unchanged brain costs one small query.

import { createHash } from 'node:crypto';
import { markdown, storage, sync } from '@somememos/core';
import type pg from 'pg';
import { BLOG_SLUG } from './blog-settings.js';
import { BrainRepo, isCommitId, runGitRaw } from './git.js';

/** A post larger than this is not served (and not listed). */
export const MAX_POST_BYTES = 512 * 1024;

/** What a public page may show about the blog itself. */
export interface PublicBlogSettings {
  readonly slug: string;
  readonly title: string;
  readonly description: string | null;
  readonly author: string | null;
  readonly language: string;
}

/** A published post, as public pages see it. It deliberately has no path. */
export interface PublicPost {
  /**
   * The post's address below the blog root: `YYYY/MM/DD/{slug}` for a post
   * dated by its path, `p/{slug}` for one without a date. It depends only on
   * the post's path, never its text.
   */
  readonly key: string;
  readonly slug: string;
  /** `YYYY-MM-DD` from the path, or null. */
  readonly date: string | null;
  readonly title: string;
  readonly description: string | null;
  /** The markdown after the front matter (front matter is never shown). */
  readonly body: string;
  /** SHA-256 of the post's text. */
  readonly hash: string;
  /** When the post was first published (Unix seconds): its path's date, else its first version's time. */
  readonly published: number;
  /** When its current text was saved (Unix seconds), never before `published`. */
  readonly updated: number;
}

/** The published posts of one blog at one recorded commit. */
export interface BlogSnapshot {
  /** Newest first. Never contains a draft. */
  readonly posts: readonly PublicPost[];
  /** The post at `key`, or undefined. */
  byKey(key: string): PublicPost | undefined;
  /** The published post a `[[target]]` written in `from` names, or null (private, draft, missing). */
  link(target: string, from: PublicPost): PublicPost | null;
  /** The latest `updated` of any post (0 when there are none). */
  readonly updated: number;
}

export interface PublicBlog {
  readonly settings: PublicBlogSettings;
  readonly snapshot: BlogSnapshot;
}

export interface PublicBlogsOptions {
  readonly pool: pg.Pool;
  /** The repository directory of a brain. */
  readonly repoDir: (brainId: string) => string;
  /** Concurrent public requests allowed to use the database or git (default 4). */
  readonly maxConcurrent?: number;
  /** Brains whose snapshot is kept (default 64). */
  readonly cacheSize?: number;
}

/** A post's slug: letters and digits (any script), lower-cased, runs of anything else as one hyphen. */
export function postSlug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
    .replace(/-+$/, '');
}

/** The address key a blog post's path gives it, or null when it has none. */
export function postKey(path: string, date: string | null): { key: string; slug: string } | null {
  let name = markdown.stripMd(markdown.baseName(path));
  if (date !== null && name.startsWith(`${date}-`)) name = name.slice(date.length + 1);
  else if (date !== null && name === date) name = '';
  const slug = postSlug(name);
  if (slug === '') return null;
  if (date === null) return { key: `p/${slug}`, slug };
  const [y, m, d] = date.split('-') as [string, string, string];
  return { key: `${y}/${m}/${d}/${slug}`, slug };
}

const SIMPLE_KEY = (key: string) => new RegExp(`^${key}[ \\t]*:[ \\t]*(.*)$`);

/** A simple one-line scalar from front matter (`description: …`), or null. */
function frontMatterScalar(raw: string, keys: readonly string[]): string | null {
  for (const key of keys) {
    const re = SIMPLE_KEY(key);
    for (const line of raw.split('\n')) {
      const m = re.exec(line);
      if (!m) continue;
      let v = (m[1] ?? '').trim();
      const quoted = /^(["'])(.*)\1$/.exec(v);
      if (quoted) v = quoted[2] as string;
      else v = v.replace(/(^|[ \t])#.*$/, '').trim();
      if (v !== '' && !/^[|>[{&*!%@`]/.test(v)) return v;
    }
  }
  return null;
}

function firstParagraph(lines: readonly markdown.ScannedLine[], from: number): string | null {
  const para: string[] = [];
  // HTML comments are private remarks: never part of a summary.
  let open = false;
  for (let i = from; i < lines.length; i++) {
    const line = lines[i] as markdown.ScannedLine;
    if (open || line.kind === 'text') {
      const stripped = markdown.stripHtmlComments(line.text, open);
      open = stripped.open;
      if (line.kind !== 'text') continue;
      const text = stripped.text.trim();
      if (text === '') {
        if (para.length > 0 && !open) break;
        continue;
      }
      if (/^\s*(?:[-*+>]|\d+[.)]|\||!\[)/.test(text) && para.length === 0) continue;
      para.push(text);
    } else if (para.length > 0) break;
  }
  const text = markdown.stripInlineMarkdown(para.join(' '));
  if (text === '') return null;
  return text.length > 200 ? `${text.slice(0, 199).replace(/\s+\S*$/, '')}…` : text;
}

function humanize(slug: string): string {
  const words = slug.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

interface Candidate {
  readonly path: string;
  readonly date: string | null;
  readonly key: string;
  readonly slug: string;
}

/**
 * A post's public title and summary: the front matter's, else its first
 * `#` heading and first paragraph, never anything inside an HTML comment.
 */
export function postHeadline(
  text: string,
  slug: string,
): { title: string; description: string | null } {
  const scan = markdown.scanBlocks(text);
  return headlineOf(scan, slug);
}

function headlineOf(
  scan: markdown.BlockScan,
  slug: string,
): { title: string; description: string | null } {
  // A heading's comments are not part of the title (they are not shown either).
  const headingText = (l: markdown.ScannedLine) =>
    markdown.stripInlineMarkdown(markdown.stripHtmlComments(l.heading ?? '').text);
  // A heading inside a multi-line comment is not one.
  let open = false;
  const heading = scan.lines.slice(scan.bodyStart).find((l) => {
    const inside = open;
    if (open || l.kind === 'text' || l.kind === 'heading') {
      open = markdown.stripHtmlComments(l.text, open).open;
    }
    return !inside && l.kind === 'heading' && l.level === 1 && headingText(l) !== '';
  });
  const title = scan.frontMatter?.title ?? (heading ? headingText(heading) : humanize(slug));
  const description =
    (scan.frontMatter
      ? frontMatterScalar(scan.frontMatter.raw, ['description', 'summary'])
      : null) ?? firstParagraph(scan.lines, scan.bodyStart);
  return { title, description };
}

/** Parses one published post's text; `times` are its first and latest versions. */
function makePost(c: Candidate, text: string, times: { first: number; last: number }): PublicPost {
  const scan = markdown.scanBlocks(text);
  const { title, description } = headlineOf(scan, c.slug);
  const body = scan.lines
    .slice(scan.bodyStart)
    .map((l) => l.text)
    .join('\n');
  const published = c.date !== null ? Date.parse(`${c.date}T00:00:00Z`) / 1000 : times.first;
  return {
    key: c.key,
    slug: c.slug,
    date: c.date,
    title,
    description,
    body,
    hash: createHash('sha256').update(text, 'utf8').digest('hex'),
    published,
    updated: Math.max(published, times.last),
  };
}

function snapshotOf(posts: Map<string, PublicPost>, pathOf: Map<PublicPost, string>): BlogSnapshot {
  const list = [...posts.values()].sort(
    (a, b) => b.published - a.published || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const byPath = new Map<string, PublicPost>();
  for (const [post, path] of pathOf) byPath.set(path, post);
  // Resolution sees published posts only: nothing private can influence it.
  const resolver = markdown.createLinkResolver(byPath.keys());
  return {
    posts: list,
    byKey: (key) => posts.get(key),
    link(target, from) {
      const source = pathOf.get(from);
      if (source === undefined) return null;
      const r = resolver.resolve(target, source);
      return r.kind === 'resolved' ? (byPath.get(r.path) ?? null) : null;
    },
    updated: list.reduce((max, p) => Math.max(max, p.updated), 0),
  };
}

const EMPTY: BlogSnapshot = snapshotOf(new Map(), new Map());

/** A counting semaphore: anonymous traffic never holds more than a few database connections. */
class Gate {
  private readonly limit: number;
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(limit: number) {
    this.limit = limit;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

interface BlogRow {
  brain_id: string;
  slug: string;
  title: string;
  description: string | null;
  author: string | null;
  language: string;
  config: string;
  git_head: string | null;
}

/** The public blogs of a server. */
export class PublicBlogs {
  private readonly options: PublicBlogsOptions;
  private readonly cache = new Map<
    string,
    { commit: string; config: string; snapshot: Promise<BlogSnapshot> }
  >();
  private readonly gate: Gate;
  private readonly cacheSize: number;

  constructor(options: PublicBlogsOptions) {
    this.options = options;
    this.gate = new Gate(options.maxConcurrent ?? 4);
    this.cacheSize = options.cacheSize ?? 64;
  }

  /**
   * The blog published under `slug` with its published posts, or null when
   * there is none: no such slug, or its owner has not turned it on. The two
   * are not told apart.
   */
  async open(slug: string): Promise<PublicBlog | null> {
    if (!BLOG_SLUG.test(slug)) return null;
    return this.gate.run(async () => {
      const { rows } = await this.options.pool.query<BlogRow>(
        `SELECT b.brain_id, b.slug, b.title, b.description, b.author, b.language, s.config, s.git_head
         FROM server_blogs b JOIN server_brains s USING (brain_id)
         WHERE b.slug = $1 AND b.enabled`,
        [slug],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        settings: {
          slug: row.slug,
          title: row.title,
          description: row.description,
          author: row.author,
          language: row.language,
        },
        snapshot: await this.snapshot(row),
      };
    });
  }

  /** The enabled blogs' slugs (for robots.txt), in order. */
  async enabledSlugs(limit = 1000): Promise<string[]> {
    return this.gate.run(async () => {
      const { rows } = await this.options.pool.query<{ slug: string }>(
        `SELECT slug FROM server_blogs WHERE enabled ORDER BY slug LIMIT $1`,
        [limit],
      );
      return rows.map((r) => r.slug);
    });
  }

  private snapshot(row: BlogRow): Promise<BlogSnapshot> {
    const commit = row.git_head;
    if (commit === null) return Promise.resolve(EMPTY);
    const cached = this.cache.get(row.brain_id);
    // A config change (a blog folder excluded, say) changes what is public at the same commit.
    if (cached && cached.commit === commit && cached.config === row.config) {
      this.cache.delete(row.brain_id); // most recently used last
      this.cache.set(row.brain_id, cached);
      return cached.snapshot;
    }
    const snapshot = this.build(row.brain_id, commit, row.config);
    const entry = { commit, config: row.config, snapshot };
    this.cache.delete(row.brain_id);
    this.cache.set(row.brain_id, entry);
    snapshot.catch(() => {
      if (this.cache.get(row.brain_id) === entry) this.cache.delete(row.brain_id);
    });
    while (this.cache.size > this.cacheSize) {
      this.cache.delete(this.cache.keys().next().value as string);
    }
    return snapshot;
  }

  /** Reads the published posts of `brainId` at `commit`. */
  private async build(brainId: string, commit: string, config: string): Promise<BlogSnapshot> {
    if (!isCommitId(commit)) throw new Error('the recorded commit is not a commit id');
    const roles = storage.parseBrainConfig({ ...JSON.parse(config), clientId: 'server' }).roles;
    const classifier = markdown.createRoleClassifier(roles);
    const repo = new BrainRepo(this.options.repoDir(brainId));

    // Every file of the recorded commit; keep the blog posts small enough to serve.
    const { stdout } = await runGitRaw(repo.dir, [
      'ls-tree',
      '-r',
      '-z',
      '-l',
      '--full-tree',
      commit,
    ]);
    const candidates: Candidate[] = [];
    for (const record of stdout.toString('utf8').split('\0')) {
      const m = /^\d+ blob [0-9a-f]+ +(\d+)\t(.+)$/s.exec(record);
      if (!m) continue;
      const path = m[2] as string;
      if (sync.syncPathProblem(path) !== null) continue; // nothing a client could have sent
      const role = classifier.classify(path);
      if (role?.role !== 'blog') continue;
      if (Number(m[1]) > MAX_POST_BYTES) continue;
      const date = role.date ?? null;
      const key = postKey(path, date);
      if (key) candidates.push({ path, date, ...key });
    }
    if (candidates.length === 0) return EMPTY;

    // When two posts would share an address, the first path (in byte order) has it.
    candidates.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const texts = await repo.readAt(candidates.map((c) => ({ commit, path: c.path })));
    const kept: { c: Candidate; text: string }[] = [];
    const taken = new Set<string>();
    candidates.forEach((c, i) => {
      const text = texts[i];
      if (text === undefined || !markdown.isPublished(text) || taken.has(c.key)) return;
      taken.add(c.key);
      kept.push({ c, text });
    });
    if (kept.length === 0) return EMPTY;

    // First and latest version times, from versions the recorded commit includes.
    const { rows } = await this.options.pool.query<{ path: string; first: string; last: string }>(
      `SELECT path,
              (array_agg(commit ORDER BY mutation ASC))[1] AS first,
              (array_agg(commit ORDER BY mutation DESC))[1] AS last
       FROM note_versions
       WHERE brain_id = $1 AND path = ANY($2::text[]) AND hash IS NOT NULL
         AND mutation <= (SELECT max(mutation) FROM note_versions WHERE brain_id = $1 AND commit = $3)
       GROUP BY path`,
      [brainId, kept.map((k) => k.c.path), commit],
    );
    const info = await repo.commitInfo([commit, ...rows.flatMap((r) => [r.first, r.last])]);
    const headTime = info.get(commit)?.time ?? 0;
    const timeOf = (c: string | undefined) => (c ? info.get(c)?.time : undefined) ?? headTime;
    const versions = new Map(rows.map((r) => [r.path, r]));

    const posts = new Map<string, PublicPost>();
    const pathOf = new Map<PublicPost, string>();
    for (const { c, text } of kept) {
      const v = versions.get(c.path);
      const post = makePost(c, text, { first: timeOf(v?.first), last: timeOf(v?.last) });
      posts.set(post.key, post);
      pathOf.set(post, c.path);
    }
    return snapshotOf(posts, pathOf);
  }
}
