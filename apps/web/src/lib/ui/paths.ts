// Paths for new notes, from the brain's folder roles, and route helpers.
// Pure functions: no engine calls, no DOM.

import { markdown } from '@somememos/core';

/** A brain's role config, read loosely: the `blog` role may not be in core's types yet. */
export type RolePatterns = Readonly<Partial<Record<string, readonly string[]>>>;

/** A file name from a title: lower-case words joined by hyphens ("kebab case"). */
export function slugify(title: string, maxLength = 80): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  const cut = slug.length > maxLength ? slug.slice(0, maxLength).replace(/-[^-]*$/, '') : slug;
  return cut.replace(/-+$/, '') || 'untitled';
}

/** The fixed folder a pattern starts with (`memos/**` → `memos/`); '' when it starts with a wildcard. */
export function folderOfPattern(pattern: string): string {
  const p = pattern.trim().replace(/^(?:\.\/|\/)+/, '');
  const segments = p.split('/');
  const fixed: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i] as string;
    const last = i === segments.length - 1;
    if (last || /[*?{]/.test(s) || s === '') break;
    fixed.push(s);
  }
  return fixed.length ? `${fixed.join('/')}/` : '';
}

function declared(roles: RolePatterns): boolean {
  return Object.values(roles).some((list) => (list?.length ?? 0) > 0);
}

/**
 * The folder new memos go in: the first memo pattern's folder. '' (the brain's
 * top level) when the brain declares no roles at all, since then every file is
 * a memo; null when roles are declared but none is a memo.
 */
export function memoFolder(roles: RolePatterns): string | null {
  const first = roles.memo?.[0];
  if (first !== undefined) return folderOfPattern(first);
  return declared(roles) ? null : '';
}

/** True when the brain has a blog folder. */
export function hasBlog(roles: RolePatterns): boolean {
  return (roles.blog?.length ?? 0) > 0;
}

/** `YYYY-MM-DD` for a date in local time. */
export function localDateString(date: Date = new Date()): string {
  const y = String(date.getFullYear()).padStart(4, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** A new memo's path: `<memo folder><slug>.md`. Null when the brain has no memo folder. */
export function newMemoPath(title: string, roles: RolePatterns): string | null {
  const folder = memoFolder(roles);
  return folder === null ? null : `${folder}${slugify(title)}.md`;
}

/**
 * A new blog post's path, dated `date` (`YYYY-MM-DD`). A blog pattern with
 * date placeholders and one `*` (`blog/{YYYY}/{YYYY}-{MM}-{DD}-*.md`) is
 * filled in; otherwise the post goes in `<blog folder><YYYY>/<date>-<slug>.md`
 * (PLAN.md section 8's example layout). Null when the brain has no blog folder.
 */
export function newBlogPath(title: string, date: string, roles: RolePatterns): string | null {
  const pattern = roles.blog?.[0];
  if (pattern === undefined) return null;
  const [y, m, d] = date.split('-') as [string, string, string];
  const slug = slugify(title);
  const p = pattern.trim().replace(/^(?:\.\/|\/)+/, '');
  const stars = p.split('*').length - 1;
  if (p.includes('{YYYY}') && stars === 1 && !p.includes('**') && p.endsWith('.md')) {
    return p.replaceAll('{YYYY}', y).replaceAll('{MM}', m).replaceAll('{DD}', d).replace('*', slug);
  }
  return `${folderOfPattern(p)}${y}/${date}-${slug}.md`;
}

/**
 * Where to create the note a dangling `[[target]]` asks for, so the link
 * resolves to it: the memo folder plus the target as written (link resolution
 * matches file names case-insensitively, so the name is kept, not slugified).
 * Characters that can't be in a file name are replaced; `..` and empty
 * segments are dropped.
 */
export function danglingNotePath(target: string, roles: RolePatterns): string | null {
  const folder = memoFolder(roles);
  if (folder === null) return null;
  const segments = target
    .trim()
    .replace(/\.md$/i, '')
    .split('/')
    .map((s) => s.replace(/[\\:*?"<>|#^[\]\p{Cc}]/gu, '-').trim())
    .filter((s) => s !== '' && s !== '.' && s !== '..');
  if (segments.length === 0) return null;
  const rel = segments.join('/');
  // A target that already starts with the memo folder is a path, not a name.
  return rel.startsWith(folder) && folder !== '' ? `${rel}.md` : `${folder}${rel}.md`;
}

/** `path` with `-2`, `-3`, … before `.md` until it is not in `taken`. */
export function uniquePath(path: string, taken: ReadonlySet<string>): string {
  if (!taken.has(path)) return path;
  const base = path.replace(/\.md$/i, '');
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}.md`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** A sibling path for a copy of `path` set aside after a conflict. */
export function asidePath(path: string, date: Date = new Date()): string {
  const stamp = `${localDateString(date)}-${String(date.getHours()).padStart(2, '0')}${String(
    date.getMinutes(),
  ).padStart(2, '0')}`;
  return `${path.replace(/\.md$/i, '')} (my version ${stamp}).md`;
}

/** A note path as a URL path: each segment percent-encoded, slashes kept. */
export function encodeNotePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** The first `# Heading` of a new note, from its title. */
export function initialNoteText(title: string): string {
  const t = title.trim();
  return t ? `# ${t}\n\n` : '';
}

/** The parent folder of a path ('' for the top level), and its file name. */
export function splitPath(path: string): { folder: string; name: string } {
  const i = path.lastIndexOf('/');
  return i < 0
    ? { folder: '', name: path }
    : { folder: path.slice(0, i + 1), name: path.slice(i + 1) };
}

/** True when `path` is in the brain's blog folder (matches a `blog` pattern). */
export function isBlogPath(path: string, roles: RolePatterns): boolean {
  return (roles.blog ?? []).some((pattern) => {
    try {
      return markdown.compilePathPattern(pattern).match(path) !== null;
    } catch {
      return false;
    }
  });
}

/** A readable title for a new note, from its path's file name. */
export function titleFromPath(path: string): string {
  const name = splitPath(path).name.replace(/\.md$/i, '');
  return name.charAt(0).toUpperCase() + name.slice(1);
}
