// Helpers shared by the query commands (search, the activation lists, read,
// log, export, eval): argument checks, note path resolution, and the one-line
// text forms an agent reads.

import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { engine, markdown, ranking } from '@somememos/core';
import type { Session } from '../brain/index.js';
import { UsageError } from '../context.js';

/** `--limit N`: a whole number >= 0, or the default. */
export function parseLimit(value: string | undefined, fallback?: number): number | undefined {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new UsageError(`--limit must be a whole number, not ${JSON.stringify(value)}`);
  }
  return Number(value);
}

/** A `YYYY-MM-DD` option value, checked. */
export function parseDateOption(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!markdown.parseCalendarDate(value)) {
    throw new UsageError(`--${name} must be a date like 2026-01-31, not ${JSON.stringify(value)}`);
  }
  return value;
}

/** Unix seconds of local midnight at the start of `date` (`YYYY-MM-DD`). */
export function localMidnight(date: string): number {
  const d = markdown.parseCalendarDate(date);
  if (!d) throw new RangeError(`not a calendar date: ${date}`);
  return Math.floor(new Date(d.year, d.month - 1, d.day).getTime() / 1000);
}

/**
 * A `--since`/`--until` time option for the change log: a local date
 * (`YYYY-MM-DD`; `until` includes the whole day), an ISO date-time, or
 * `@<unix seconds>`. Returns Unix seconds: `since` inclusive, `until` exclusive.
 */
export function parseTimeOption(
  name: 'since' | 'until',
  value: string | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  if (/^@\d+$/.test(value)) return Number(value.slice(1)) + (name === 'until' ? 1 : 0);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    if (!markdown.parseCalendarDate(value)) {
      throw new UsageError(`--${name}: not a calendar date: ${value}`);
    }
    const start = localMidnight(value);
    if (name === 'since') return start;
    const d = markdown.parseCalendarDate(value) as { year: number; month: number; day: number };
    return Math.floor(new Date(d.year, d.month - 1, d.day + 1).getTime() / 1000);
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)) {
    const ms = Date.parse(value.replace(' ', 'T'));
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000) + (name === 'until' ? 1 : 0);
  }
  throw new UsageError(
    `--${name} must be a date (2026-01-31), a date-time (2026-01-31T09:30) or @<unix seconds>, not ${JSON.stringify(value)}`,
  );
}

/**
 * A note path the user typed, as a brain-relative path: relative to the
 * working directory (or absolute) when that names an existing file in the
 * brain, else brain-relative when that does (so the paths `search` prints
 * work from anywhere), else the working-directory reading for the engine to
 * refuse. Throws a UsageError for a path outside the brain.
 */
export function resolveNotePath(brain: Session, userPath: string): string {
  const fromCwd = brain.brainPath(userPath);
  if (fromCwd !== null && fromCwd !== '' && existsSync(join(brain.root, fromCwd))) return fromCwd;
  const rel = isAbsolute(userPath) ? null : markdown.normalizePath(userPath);
  if (rel !== null && rel !== '' && existsSync(join(brain.root, rel))) return rel;
  if (fromCwd !== null) return fromCwd;
  if (rel !== null && rel !== '') return rel;
  throw new UsageError(`${userPath} is outside the brain`);
}

/** Collapses whitespace and cuts a text to at most `max` characters, with `…`. */
export function oneLineText(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** A score for display: two decimals, or two significant figures (with an exponent) below 0.01. */
export function formatScore(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n === 0) return '0';
  if (Math.abs(n) < 0.01) return n.toExponential(1);
  if (n >= 100) return n.toFixed(0);
  if (n >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

/**
 * The compact activity indicator for an activation list line, from the
 * result's "score now" view:
 * - hot: the weighted score now at the hot half-life, e.g. `week 1.42`;
 * - trending: the pace (1.0 is an item's usual pace for daily activity), e.g. `pace 1.8x`;
 * - neglected: the long and short scores now, e.g. `year 3.10 month 0.20`.
 */
export function activityIndicator(r: engine.ResultView, mode: ranking.RankMode): string {
  const h = ranking.DEFAULT_RANKING_PARAMS.halfLives;
  const a = r.now.activation;
  if (mode === 'trending') return `pace ${formatScore(r.now.trendingPace)}x`;
  if (mode === 'neglected') {
    return `${h.neglectedLong} ${formatScore(a[h.neglectedLong])} ${h.neglectedShort} ${formatScore(a[h.neglectedShort])}`;
  }
  return `${h.hot} ${formatScore(a[h.hot])}`;
}

/**
 * The path as `brain.displayPath` shows it, or a dangling item marked as such,
 * with its link text as written (`title`, capitals kept; else the key).
 */
export function resultLabel(brain: Session, r: engine.ResultView): string {
  return r.path === null ? `(not written yet) ${r.title || r.item}` : brain.displayPath(r.path);
}
