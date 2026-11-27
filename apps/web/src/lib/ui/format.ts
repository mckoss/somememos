// Turning a result's score components into words and small numbers a person
// can read. Display only: nothing here affects ranking.

import type { engine } from '@somememos/core';
import { ranking, timescore } from '@somememos/core';

type ResultView = engine.ResultView;
type RankMode = engine.RankMode;

const DAY = 86_400;

/** The half-lives the UI explains, shortest first, with plain names. */
export const HALF_LIFE_LABELS: ReadonlyArray<{ name: string; label: string; window: string }> = [
  { name: 'day', label: 'Today', window: 'about the last day' },
  { name: 'week', label: 'This week', window: 'about the last week' },
  { name: 'month', label: 'This month', window: 'about the last month' },
  { name: 'year', label: 'This year', window: 'about the last year' },
];

export const KIND_LABELS = { read: 'Reads', edit: 'Edits', mention: 'Mentions' } as const;
export type Kind = keyof typeof KIND_LABELS;
export const KINDS: readonly Kind[] = ['read', 'edit', 'mention'];

export const MODE_LABELS: Record<RankMode, string> = {
  hot: 'Hot',
  trending: 'Trending',
  neglected: 'Neglected',
  all: 'Keyword only',
};

export const MODE_DESCRIPTIONS: Record<RankMode, string> = {
  hot: 'What you have been using most lately.',
  trending: 'Notes getting more attention than usual.',
  neglected: 'Notes that mattered over the year but have gone quiet.',
  all: 'Best keyword match, ignoring activity.',
};

/** A number with about two significant figures; small values keep a decimal. */
export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '–';
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  if (abs >= 100) return Math.round(value).toLocaleString('en-US');
  if (abs >= 10) return value.toFixed(0);
  if (abs >= 1) return value.toFixed(1);
  if (abs >= 0.01) return value.toFixed(2);
  return '<0.01';
}

/**
 * A score "now" (each interaction worth 1 when it happened, halved every
 * half-life) as an average pace in interactions per week over that window.
 * One interaction a day, steadily, reads as 7 a week at every half-life, so
 * the four paces can be compared: a note that is heating up has a faster pace
 * over the short windows than over the long ones.
 */
export function weeklyPace(scoreNow: number, halfLifeSeconds: number): number {
  if (!(scoreNow > 0) || !(halfLifeSeconds > 0)) return 0;
  const perDay = scoreNow * -Math.expm1((-DAY * Math.LN2) / halfLifeSeconds);
  return perDay * 7;
}

/** "about 3 a week", "less than one a week", "none". */
export function describePace(perWeek: number): string {
  if (!(perWeek > 0)) return 'none';
  if (perWeek < 0.05) return 'almost none';
  if (perWeek < 0.95) {
    const perMonth = (perWeek * 30) / 7;
    return perMonth >= 0.95 ? `about ${formatNumber(perMonth)} a month` : 'less than one a month';
  }
  return `about ${formatNumber(perWeek)} a week`;
}

export interface PaceRow {
  readonly name: string;
  readonly label: string;
  readonly window: string;
  /** Interactions a week, averaged over the window. */
  readonly perWeek: number;
  /** The raw weighted score now, for the detail line. */
  readonly score: number;
  /** 0–1, relative to the fastest of the four, for the bar. */
  readonly fraction: number;
}

/** One row per half-life: the note's pace over that window. */
export function paceRows(
  result: Pick<ResultView, 'now'>,
  halfLives: Readonly<Record<string, number>> = timescore.HALF_LIVES,
): PaceRow[] {
  const rows = HALF_LIFE_LABELS.map((h) => {
    const score = result.now.activation[h.name] ?? 0;
    const seconds = halfLives[h.name] ?? 0;
    return { ...h, score: score ?? 0, perWeek: weeklyPace(score ?? 0, seconds) };
  });
  const max = Math.max(0, ...rows.map((r) => r.perWeek));
  return rows.map((r) => ({ ...r, fraction: max > 0 ? r.perWeek / max : 0 }));
}

export interface KindSplit {
  readonly kind: Kind;
  readonly label: string;
  readonly score: number;
  /** 0–1 share of the total. */
  readonly share: number;
}

/** Which half-life a mode's kind split is read at. */
export function splitHalfLife(mode: RankMode): string {
  const h = ranking.DEFAULT_RANKING_PARAMS.halfLives;
  if (mode === 'neglected') return h.neglectedLong;
  if (mode === 'all') return 'year';
  return h.hot;
}

/** How much of the activity at `halfLife` came from reads, edits and mentions. */
export function kindSplit(result: Pick<ResultView, 'now'>, halfLife: string): KindSplit[] {
  const byKind = result.now.kinds[halfLife] ?? {};
  const scores = KINDS.map((kind) => ({ kind, score: Math.max(0, byKind[kind] ?? 0) }));
  const total = scores.reduce((sum, s) => sum + s.score, 0);
  return scores.map((s) => ({
    ...s,
    label: KIND_LABELS[s.kind],
    share: total > 0 ? s.score / total : 0,
  }));
}

/** `S_long / S_short` for steady daily use, so a neglected ratio can be read against "usual". */
export function steadyNeglectedRatio(
  halfLives: Readonly<Record<string, number>> = timescore.HALF_LIVES,
): number {
  const h = ranking.DEFAULT_RANKING_PARAMS.halfLives;
  const long = halfLives[h.neglectedLong];
  const short = halfLives[h.neglectedShort];
  if (long === undefined || short === undefined) return NaN;
  return timescore.steadyRatio(long, short, DAY);
}

export interface Signal {
  /** A short label: "Heating up", "Steady", "Cooling", "No recent activity". */
  readonly label: string;
  /** One plain sentence. */
  readonly sentence: string;
  /** The number behind it, e.g. 2.3 for "2.3× its usual pace"; null when there is none. */
  readonly value: number | null;
  /** 'up' | 'flat' | 'down' | 'none', for styling. */
  readonly tone: 'up' | 'flat' | 'down' | 'none';
}

/** The trending signal, read so that 1.0 is the note's usual pace. */
export function trendingSignal(result: Pick<ResultView, 'now'>): Signal {
  const pace = result.now.trendingPace ?? 0;
  if (!(pace > 0)) {
    return {
      label: 'No recent activity',
      sentence: 'Nothing has happened with this note in the last few weeks.',
      value: null,
      tone: 'none',
    };
  }
  const x = formatNumber(pace);
  if (pace >= 1.25) {
    return {
      label: 'Heating up',
      sentence: `This week it is getting about ${x}× its usual attention.`,
      value: pace,
      tone: 'up',
    };
  }
  if (pace > 0.8) {
    return {
      label: 'Steady',
      sentence: `It is being used at about its usual pace (${x}×).`,
      value: pace,
      tone: 'flat',
    };
  }
  return {
    label: 'Cooling',
    sentence: `This week it is getting less attention than usual (${x}×).`,
    value: pace,
    tone: 'down',
  };
}

/**
 * The neglected signal: how much quieter the last month has been than the
 * note's pace over the year, where 1.0 means "as busy as ever".
 */
export function neglectedSignal(
  result: Pick<ResultView, 'now'>,
  halfLives: Readonly<Record<string, number>> = timescore.HALF_LIVES,
): Signal {
  const ratio = result.now.neglectedRatio ?? 0;
  const steady = steadyNeglectedRatio(halfLives);
  if (!(ratio > 0) || !(steady > 0)) {
    return {
      label: 'No history',
      sentence: 'There is not enough past activity to tell whether it has gone quiet.',
      value: null,
      tone: 'none',
    };
  }
  const quiet = ratio / steady;
  const x = formatNumber(quiet);
  if (quiet >= 1.5) {
    return {
      label: 'Gone quiet',
      sentence: `It mattered over the year, but the last month has been about ${x}× quieter than its usual pace.`,
      value: quiet,
      tone: 'down',
    };
  }
  if (quiet > 0.67) {
    return {
      label: 'As usual',
      sentence: `The last month has been about as busy as its year (${x}×).`,
      value: quiet,
      tone: 'flat',
    };
  }
  return {
    label: 'Busier lately',
    sentence: `The last month has been busier than its year as a whole (${x}×).`,
    value: quiet,
    tone: 'up',
  };
}

/** A compact one-line summary for a result card, chosen by mode. */
export function scoreSummary(
  result: Pick<ResultView, 'now' | 'components' | 'dangling'>,
  mode: RankMode,
  halfLives: Readonly<Record<string, number>> = timescore.HALF_LIVES,
): string {
  if (mode === 'trending') {
    const s = trendingSignal(result);
    return s.value === null ? s.label : `${s.label} · ${formatNumber(s.value)}× usual`;
  }
  if (mode === 'neglected') {
    const s = neglectedSignal(result, halfLives);
    return s.value === null ? s.label : `${s.label} · ${formatNumber(s.value)}× quieter`;
  }
  const week = paceRows(result, halfLives).find((r) => r.name === 'week');
  const pace = week ? describePace(week.perWeek) : 'none';
  if (mode === 'all' && result.components.relevance !== null) {
    return `Match ${formatNumber(result.components.relevance)} · ${pace === 'none' ? 'no recent activity' : pace}`;
  }
  return pace === 'none' ? 'No recent activity' : `Lately ${pace}`;
}

/** How strong a keyword match is, in words, relative to the best match in the list. */
export function relevanceWords(relevance: number | null, best: number | null): string {
  if (relevance === null) return 'No keywords';
  if (best === null || !(best > 0)) return 'Matches';
  const f = relevance / best;
  if (f >= 0.8) return 'Strong match';
  if (f >= 0.4) return 'Good match';
  return 'Weak match';
}

/** "3 minutes ago", "yesterday", "12 Mar 2026". */
export function relativeTime(unixSeconds: number, now: number = Date.now() / 1000): string {
  const d = now - unixSeconds;
  if (d < 45) return 'just now';
  if (d < 90 * 60) return `${Math.max(1, Math.round(d / 60))} min ago`;
  if (d < 24 * 3600) return `${Math.round(d / 3600)} h ago`;
  if (d < 48 * 3600) return 'yesterday';
  if (d < 7 * DAY) return `${Math.round(d / DAY)} days ago`;
  return new Date(unixSeconds * 1000).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** Bytes as "1.2 MB". */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return 'unknown';
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return i === 0 ? `${v} bytes` : `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

/** "1 note", "3 notes". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}
