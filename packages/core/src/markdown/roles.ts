// Folder roles (PLAN.md section 4, "Folder roles and the default layout"):
// path patterns, the dates in `dated` and `blog` paths, and classifying a
// note's path.

import { isMarkdownPath } from './paths.js';

/**
 * - `memo`: a lasting note; a scored item.
 * - `dated`: an entry for one day, its date from the path.
 * - `source`: immutable source material.
 * - `blog`: a post the owner may publish (PLAN.md section 8). Scored exactly
 *   like a memo, and, when its pattern has date placeholders, dated from its
 *   path like a `dated` entry (the date is optional: null otherwise).
 * - `excluded`: never indexed, logged or shown.
 */
export type FolderRole = 'memo' | 'dated' | 'source' | 'blog' | 'excluded';

/** Roles in precedence order: the first role with a matching pattern wins. */
export const ROLE_PRECEDENCE: readonly FolderRole[] = [
  'excluded',
  'source',
  'dated',
  'blog',
  'memo',
];

/** Roles whose notes are scored items (edit, read and mention events; the activation lists). */
export const SCORED_ROLES: readonly FolderRole[] = Object.freeze(['memo', 'blog'] as const);

/** True for `memo` and `blog`: the roles whose notes are scored items. */
export function isScoredRole(role: FolderRole | null | undefined): boolean {
  return role === 'memo' || role === 'blog';
}

/** A brain's role config: each role maps to a list of path patterns. */
export type FolderRolesConfig = Partial<Record<FolderRole, readonly string[]>>;

/**
 * The layout new brains start with. Blog posts have two patterns, tried in
 * order: a dated post (`blog/2026/2026-11-27-why-memos.md`) gets its date
 * from the path; anything else in `blog/` is a post with no date.
 */
export const DEFAULT_FOLDER_ROLES: FolderRolesConfig = {
  memo: ['memos/'],
  dated: ['diary/{YYYY}/{MM}/{YYYY}-{MM}-{DD}.md'],
  source: ['sources/'],
  blog: ['blog/{YYYY}/{YYYY}-{MM}-{DD}-*.md', 'blog/'],
};

export class PathPatternError extends Error {
  override name = 'PathPatternError';
}

// ---------------------------------------------------------------------------
// Calendar dates

/** True for a real Gregorian date, years 1-9999. */
export function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (![year, month, day].every(Number.isInteger)) return false;
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] as number;
  return day <= days;
}

/** Parses `YYYY-MM-DD`, returning null unless it is a real calendar date. */
export function parseCalendarDate(
  date: string,
): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return isValidCalendarDate(year, month, day) ? { year, month, day } : null;
}

// ---------------------------------------------------------------------------
// Patterns

const PLACEHOLDERS = { YYYY: ['Y', 4], MM: ['M', 2], DD: ['D', 2] } as const;
type Placeholder = keyof typeof PLACEHOLDERS;

export interface PathPattern {
  /** The pattern as written. */
  source: string;
  /** True when the pattern has all of `{YYYY}`, `{MM}` and `{DD}`. */
  hasDate: boolean;
  /** True when the pattern has at least one date placeholder. */
  hasPlaceholder?: boolean;
  /**
   * Matches a brain-relative path. Returns null for no match. For a pattern
   * with a date, the date (`YYYY-MM-DD`) is returned and an impossible date
   * (`2026-02-30`) is no match.
   */
  match(path: string): { date?: string } | null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * Compiles a path pattern. Patterns are matched against the whole
 * brain-relative path, case-sensitively:
 *
 * - `*` matches any run of characters within one segment, `?` one character;
 * - a `**` segment matches zero or more whole segments;
 * - a trailing `/` means everything inside the folder (`memos/` = `memos/**`);
 * - `{YYYY}`, `{MM}` and `{DD}` match 4, 2 and 2 digits, and must agree where
 *   they repeat (`diary/{YYYY}/{YYYY}-{MM}-{DD}.md`);
 * - everything else is literal. A leading `/` or `./` is ignored.
 */
export function compilePathPattern(pattern: string): PathPattern {
  let p = pattern.trim().replace(/^(?:\.\/|\/)+/, '');
  if (p === '') throw new PathPatternError(`Empty path pattern: ${JSON.stringify(pattern)}`);
  if (p.endsWith('/')) p += '**';
  const segments = p
    .split('/')
    .filter((s, i, all) => s !== '' && !(s === '**' && all[i - 1] === '**'));

  const seen = new Set<Placeholder>();
  const segmentRegExp = (segment: string): string => {
    let out = '';
    for (let i = 0; i < segment.length; i++) {
      const ch = segment[i] as string;
      if (ch === '*') out += '[^/]*';
      else if (ch === '?') out += '[^/]';
      else if (ch === '{') {
        const close = segment.indexOf('}', i);
        const name = close < 0 ? '' : segment.slice(i + 1, close);
        if (!(name in PLACEHOLDERS)) {
          throw new PathPatternError(
            `Unknown placeholder in path pattern ${JSON.stringify(pattern)}: use {YYYY}, {MM} or {DD}`,
          );
        }
        const [group, digits] = PLACEHOLDERS[name as Placeholder];
        out += seen.has(name as Placeholder) ? `\\k<${group}>` : `(?<${group}>\\d{${digits}})`;
        seen.add(name as Placeholder);
        i = close;
      } else out += escapeRegExp(ch);
    }
    return out;
  };

  let body = '';
  let afterDoubleStar = false;
  segments.forEach((segment, i) => {
    const last = i === segments.length - 1;
    if (segment === '**') {
      if (last) body += i === 0 ? '.+' : '/.+';
      else body += i === 0 ? '(?:[^/]+/)*' : '/(?:[^/]+/)*';
      afterDoubleStar = true;
    } else {
      body += (i === 0 || afterDoubleStar ? '' : '/') + segmentRegExp(segment);
      afterDoubleStar = false;
    }
  });

  const regex = new RegExp(`^${body}$`);
  const hasDate = seen.size === 3;
  return {
    source: pattern,
    hasDate,
    hasPlaceholder: seen.size > 0,
    match(path: string) {
      const m = regex.exec(path);
      if (!m) return null;
      if (!hasDate) return {};
      const g = m.groups as Record<'Y' | 'M' | 'D', string>;
      const date = `${g.Y}-${g.M}-${g.D}`;
      return parseCalendarDate(date) ? { date } : null;
    },
  };
}

/** The date a dated pattern gives a path, or null if it doesn't match or the date is impossible. */
export function matchDatedPath(pattern: string, path: string): string | null {
  const compiled = compilePathPattern(pattern);
  if (!compiled.hasDate) {
    throw new PathPatternError(`Dated pattern lacks {YYYY}, {MM} or {DD}: ${pattern}`);
  }
  return compiled.match(path)?.date ?? null;
}

/**
 * The path a dated pattern gives a date (`YYYY-MM-DD`), for example today's
 * diary entry. The pattern must have all three placeholders and no wildcards.
 */
export function renderDatedPath(pattern: string, date: string): string {
  if (!parseCalendarDate(date)) throw new RangeError(`Not a calendar date: ${date}`);
  const compiled = compilePathPattern(pattern); // validates placeholders
  if (!compiled.hasDate) {
    throw new PathPatternError(`Dated pattern lacks {YYYY}, {MM} or {DD}: ${pattern}`);
  }
  let p = pattern.trim().replace(/^(?:\.\/|\/)+/, '');
  if (/[*?]/.test(p) || p.endsWith('/')) {
    throw new PathPatternError(`Cannot render a pattern with wildcards: ${pattern}`);
  }
  const [y, m, d] = date.split('-') as [string, string, string];
  p = p.replaceAll('{YYYY}', y).replaceAll('{MM}', m).replaceAll('{DD}', d);
  return p
    .split('/')
    .filter((s) => s !== '')
    .join('/');
}

// ---------------------------------------------------------------------------
// Classification

export interface RoleMatch {
  role: FolderRole;
  /** The pattern that matched; absent for the no-roles default. */
  pattern?: string;
  /** For `dated` paths, and `blog` paths whose pattern has a date: the date, `YYYY-MM-DD`. */
  date?: string;
}

export interface RoleClassifier {
  /** True when the config declares at least one pattern. */
  readonly declared: boolean;
  /** The `dated` patterns, in config order (the first one names today's entry). */
  readonly datedPatterns: readonly string[];
  /** The role of a note path, or null: not a markdown file, or no pattern matched. */
  classify(path: string): RoleMatch | null;
}

/**
 * Builds a classifier from a role config, validating every pattern. `excluded`
 * wins over `source`, then `dated`, then `blog`, then `memo`; within a role,
 * patterns are tried in config order. A dated pattern (in `dated` or `blog`)
 * whose path holds an impossible date does not match, so the path falls
 * through to the next pattern or role. A `blog` pattern may have no date
 * placeholders (its posts then have no date), but not just some of them. A
 * config that declares no patterns makes every `.md` file a memo; once any
 * role is declared, a file that matches nothing has no role.
 */
export function createRoleClassifier(config: FolderRolesConfig = {}): RoleClassifier {
  const compiled = ROLE_PRECEDENCE.map((role) => {
    const patterns = (config[role] ?? []).map(compilePathPattern);
    if (role === 'dated') {
      for (const p of patterns) {
        if (!p.hasDate) {
          throw new PathPatternError(`Dated pattern lacks {YYYY}, {MM} or {DD}: ${p.source}`);
        }
      }
    }
    if (role === 'blog') {
      for (const p of patterns) {
        if (p.hasPlaceholder && !p.hasDate) {
          throw new PathPatternError(
            `Blog pattern has some but not all of {YYYY}, {MM} and {DD}: ${p.source}`,
          );
        }
      }
    }
    return { role, patterns };
  });
  const declared = compiled.some((c) => c.patterns.length > 0);

  return {
    declared,
    datedPatterns: [...(config.dated ?? [])],
    classify(path: string): RoleMatch | null {
      if (!isMarkdownPath(path)) return null;
      if (!declared) return { role: 'memo' };
      for (const { role, patterns } of compiled) {
        for (const pattern of patterns) {
          const m = pattern.match(path);
          if (!m) continue;
          const result: RoleMatch = { role, pattern: pattern.source };
          if ((role === 'dated' || role === 'blog') && m.date !== undefined) result.date = m.date;
          return result;
        }
      }
      return null;
    },
  };
}

/** Classifies one path. Builds a classifier each call: use `createRoleClassifier` for many. */
export function classifyPath(path: string, config: FolderRolesConfig = {}): RoleMatch | null {
  return createRoleClassifier(config).classify(path);
}
